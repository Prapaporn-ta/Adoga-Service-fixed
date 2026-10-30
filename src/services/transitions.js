// src/services/transitions.js — All status changes go through here.
// ทุกการเปลี่ยนสถานะตรวจกับ State Diagram (utils/stateMachine.js) "ก่อน" เขียนข้อมูล
// ถ้าขั้นตอนใดผิดเงื่อนไข จะ throw Error (ข้อความภาษาไทย) และไม่มีข้อมูลใดถูกเปลี่ยน
import { db } from '../stores/db.js'
import { transition, canTransition } from '../utils/stateMachine.js'

// ── Constants & small helpers ─────────────────────────────────────────────
export const SUPPORT_HOTEL_ID = 'H_ADMIN'
export const BOOKING_HOLD_HOURS = 12
const MAX_NIGHTS = 30
const ACTIVE_BOOKING = ['pending_payment', 'confirmed']
const PENDING_REFUND = ['submitted', 'reviewing']

export const isSupportHotel = (h) => !!h && (h.id === SUPPORT_HOTEL_ID || h.isSupport === true)
export const isActiveBooking = (b) => !!b && ACTIVE_BOOKING.includes(b.status)

const list = (key) => db[key] || []
const fail = (msg) => { throw new Error(msg) }

function pad(n) { return String(n).padStart(2, '0') }

// 'YYYY-MM-DD' (local) from a date-only string, ISO string or Date
export function dayKey(v) {
  if (!v) return ''
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  const d = v instanceof Date ? v : new Date(v)
  if (isNaN(d)) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
export const todayKey = () => dayKey(new Date())

export function nightsBetween(checkIn, checkOut) {
  const a = new Date(dayKey(checkIn) + 'T00:00:00')
  const b = new Date(dayKey(checkOut) + 'T00:00:00')
  if (isNaN(a) || isNaN(b)) return 0
  return Math.round((b - a) / 86400000)
}

// Sequential IDs that follow the Data Dictionary formats (BXXX, PAY-XXXXXX, HXXX, RFXXX)
function nextSeqId(ids, prefix, width) {
  const re = new RegExp('^' + prefix.replace(/[-]/g, '\\-') + '(\\d+)$')
  let max = 0
  for (const id of ids) {
    const m = re.exec(id || '')
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return prefix + String(max + 1).padStart(width, '0')
}

function overlaps(aIn, aOut, bIn, bOut) {
  return dayKey(aIn) < dayKey(bOut) && dayKey(bIn) < dayKey(aOut)
}

function sameUnit(b, hotelId, roomId, roomNo) {
  return b.hotelId === hotelId && b.roomId === roomId && String(b.roomNo) === String(roomNo)
}

function unitHasActiveBooking(bookings, hotelId, roomId, roomNo) {
  return bookings.some(b => isActiveBooking(b) && sameUnit(b, hotelId, roomId, roomNo))
}

// Units of a room type that can be booked for [checkIn, checkOut)
export function getAvailableUnits(hotel, roomId, checkIn, checkOut, bookings = list('adoga_bookings')) {
  const room = hotel?.rooms?.find(r => r.id === roomId)
  if (!room) return []
  return (room.units || []).filter(u =>
    u.status !== 'maintenance' &&
    !bookings.some(b => isActiveBooking(b) && sameUnit(b, hotel.id, roomId, u.no) && overlaps(checkIn, checkOut, b.checkIn, b.checkOut))
  )
}

// Room diagram: a unit is "booked" while it has at least one active booking, otherwise "available".
// Units under maintenance are left alone (they cannot hold active bookings).
function syncUnitStatuses(hotels, bookings, refs) {
  let out = hotels
  for (const ref of refs) {
    const hIdx = out.findIndex(h => h.id === ref.hotelId)
    if (hIdx === -1) continue
    const hotel = out[hIdx]
    let changed = false
    const rooms = (hotel.rooms || []).map(r => {
      if (r.id !== ref.roomId) return r
      let roomChanged = false
      const units = (r.units || []).map(u => {
        if (String(u.no) !== String(ref.roomNo) || u.status === 'maintenance') return u
        const want = unitHasActiveBooking(bookings, ref.hotelId, ref.roomId, u.no) ? 'booked' : 'available'
        if (u.status === want) return u
        roomChanged = true
        return transition('room', u, want)
      })
      if (!roomChanged) return r
      changed = true
      return { ...r, units }
    })
    if (changed) {
      out = [...out]
      out[hIdx] = { ...hotel, rooms }
    }
  }
  return out
}

function findIndexOrFail(items, id, label) {
  const idx = items.findIndex(x => x.id === id)
  if (idx === -1) fail(`ไม่พบ${label}`)
  return idx
}

// ── Booking + Payment ─────────────────────────────────────────────────────
export function createBooking({ userId, hotelId, roomId, roomNo, guests, checkIn, checkOut, paymentMethod }) {
  const bookings = list('adoga_bookings')
  const hotels = list('adoga_hotels')
  const user = list('adoga_users').find(u => u.id === userId)
  if (!user || user.role !== 'user') fail('เฉพาะลูกค้าที่เข้าสู่ระบบแล้วเท่านั้นที่จองห้องพักได้')

  const hotel = hotels.find(h => h.id === hotelId)
  if (!hotel || isSupportHotel(hotel)) fail('ไม่พบโรงแรมนี้')
  if (hotel.status !== 'approved') fail('โรงแรมนี้ยังไม่เปิดรับจอง')
  const room = hotel.rooms?.find(r => r.id === roomId)
  if (!room) fail('ไม่พบประเภทห้องพัก')

  const ci = dayKey(checkIn)
  const co = dayKey(checkOut)
  if (!ci || !co) fail('กรุณาเลือกวันเช็คอินและเช็คเอาท์')
  if (ci < todayKey()) fail('วันเช็คอินต้องไม่ใช่วันที่ผ่านมาแล้ว')
  const nights = nightsBetween(ci, co)
  if (nights < 1) fail('วันเช็คเอาท์ต้องอยู่หลังวันเช็คอิน')
  if (nights > MAX_NIGHTS) fail(`จองได้สูงสุด ${MAX_NIGHTS} คืนต่อครั้ง`)

  const g = Number(guests) || 0
  if (g < 1 || g > (room.capacity || 1)) fail(`ห้องประเภทนี้รองรับได้ 1–${room.capacity} ท่าน`)
  if (!['QR', 'BANK_TRANSFER'].includes(paymentMethod || 'QR')) fail('ช่องทางการชำระเงินไม่ถูกต้อง')

  const free = getAvailableUnits(hotel, roomId, ci, co, bookings)
  const unit = (roomNo && free.find(u => String(u.no) === String(roomNo))) || free[0]
  if (!unit) fail('ห้องประเภทนี้เต็มในช่วงวันที่เลือก กรุณาเลือกวันอื่นหรือประเภทห้องอื่น')

  const now = new Date()
  const booking = {
    id: nextSeqId(bookings.map(b => b.id), 'B', 3),
    paymentId: nextSeqId(bookings.map(b => b.paymentId), 'PAY-', 6),
    userId, hotelId, roomId, roomNo: unit.no,
    guests: g, checkIn: ci, checkOut: co, nights,
    totalPrice: Math.round(nights * room.price * (1 - (Number(hotel.discount) || 0) / 100)),
    status: 'pending_payment', cancelReason: null,
    paymentMethod: paymentMethod || 'QR', paymentStatus: 'awaiting',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + BOOKING_HOLD_HOURS * 3600000).toISOString(),
    checkedInAt: null, checkedOutAt: null,
    statusHistory: [],
  }
  const nextBookings = [...bookings, booking]
  const nextHotels = syncUnitStatuses(hotels, nextBookings, [booking])
  db['adoga_bookings'] = nextBookings
  db['adoga_hotels'] = nextHotels
  return booking
}

function isExpired(b) {
  return b.status === 'pending_payment' && b.expiresAt && new Date(b.expiresAt) < new Date()
}

export function startPayment(bookingId) {
  const bookings = [...list('adoga_bookings')]
  const idx = findIndexOrFail(bookings, bookingId, 'การจอง')
  let b = bookings[idx]
  if (b.status !== 'pending_payment') fail('การจองนี้ไม่อยู่ในสถานะรอชำระเงิน')
  if (isExpired(b)) fail('การจองนี้หมดเวลาชำระเงินแล้ว')
  if (b.paymentStatus === 'failed') b = transition('payment', b, 'awaiting')
  b = transition('payment', b, 'verifying')
  bookings[idx] = b
  db['adoga_bookings'] = bookings
  return b
}

export function finishPayment(bookingId, success) {
  const bookings = [...list('adoga_bookings')]
  const idx = findIndexOrFail(bookings, bookingId, 'การจอง')
  let b = bookings[idx]
  if (success) {
    b = transition('payment', b, 'success')
    b = transition('booking', b, 'confirmed')
    b = { ...b, paidAt: new Date().toISOString() }
  } else {
    b = transition('payment', b, 'failed')
  }
  bookings[idx] = b
  db['adoga_bookings'] = bookings
  return b
}

export function retryPayment(bookingId) {
  const bookings = [...list('adoga_bookings')]
  const idx = findIndexOrFail(bookings, bookingId, 'การจอง')
  const b = bookings[idx]
  if (b.status !== 'pending_payment') fail('การจองนี้ไม่อยู่ในสถานะรอชำระเงิน')
  bookings[idx] = transition('payment', b, 'awaiting')
  db['adoga_bookings'] = bookings
  return bookings[idx]
}

// ลูกค้ายกเลิกได้เฉพาะการจองที่ยังไม่ชำระเงิน (ที่ชำระแล้วต้องยื่นขอคืนเงิน)
export function cancelBooking(bookingId, reason = 'user', actorUserId = null) {
  const bookings = [...list('adoga_bookings')]
  const idx = findIndexOrFail(bookings, bookingId, 'การจอง')
  const b = bookings[idx]
  if (actorUserId && b.userId !== actorUserId) fail('คุณไม่มีสิทธิ์ยกเลิกการจองนี้')
  if (b.status !== 'pending_payment') fail('ยกเลิกได้เฉพาะการจองที่ยังไม่ชำระเงิน หากชำระแล้วกรุณายื่นขอคืนเงิน')
  if (b.paymentStatus === 'verifying') fail('กำลังตรวจสอบการชำระเงิน กรุณารอสักครู่')
  bookings[idx] = { ...transition('booking', b, 'cancelled'), cancelReason: reason }
  const hotels = syncUnitStatuses(list('adoga_hotels'), bookings, [b])
  db['adoga_bookings'] = bookings
  db['adoga_hotels'] = hotels
}

// Lazy expiry: called on app load and every navigation
export function sweepExpired() {
  const bookings = [...list('adoga_bookings')]
  const touched = []
  bookings.forEach((b, idx) => {
    if (isExpired(b) && b.paymentStatus !== 'verifying') {
      bookings[idx] = { ...transition('booking', b, 'cancelled'), cancelReason: 'expired' }
      touched.push(b)
    }
  })
  if (!touched.length) return
  const hotels = syncUnitStatuses(list('adoga_hotels'), bookings, touched)
  db['adoga_bookings'] = bookings
  db['adoga_hotels'] = hotels
}

// ── Check-in / Check-out (ผู้จัดการโรงแรม) ─────────────────────────────────
export function hasPendingRefund(bookingId, refunds = list('adoga_refunds')) {
  return refunds.some(r => r.bookingId === bookingId && PENDING_REFUND.includes(r.status))
}

export function checkInBlockReason(b, refunds = list('adoga_refunds')) {
  if (!b) return 'ไม่พบการจอง'
  if (b.status !== 'confirmed' || b.paymentStatus !== 'success') return 'เช็คอินได้เฉพาะการจองที่ชำระเงินและยืนยันแล้ว'
  if (b.checkedInAt) return 'ผู้เข้าพักเช็คอินแล้ว'
  if (hasPendingRefund(b.id, refunds)) return 'การจองนี้มีคำขอคืนเงินค้างอยู่ กรุณาพิจารณาคำขอก่อน'
  const today = todayKey()
  if (today < dayKey(b.checkIn)) return 'ยังไม่ถึงวันเช็คอิน'
  if (today >= dayKey(b.checkOut)) return 'เลยกำหนดวันเข้าพักแล้ว'
  return ''
}

export function checkIn(bookingId) {
  const bookings = [...list('adoga_bookings')]
  const idx = findIndexOrFail(bookings, bookingId, 'การจอง')
  const reason = checkInBlockReason(bookings[idx])
  if (reason) fail(reason)
  bookings[idx] = { ...bookings[idx], checkedInAt: new Date().toISOString() }
  db['adoga_bookings'] = bookings
}

// ยกเลิกการเช็คอินที่กดผิด (ยังไม่เช็คเอาท์) — สถานะการจองยังเป็น "ยืนยันแล้ว"
export function revertToWaiting(bookingId) {
  const bookings = [...list('adoga_bookings')]
  const idx = findIndexOrFail(bookings, bookingId, 'การจอง')
  const b = bookings[idx]
  if (b.status !== 'confirmed' || !b.checkedInAt) fail('ย้อนกลับได้เฉพาะผู้ที่เช็คอินแล้วแต่ยังไม่เช็คเอาท์')
  bookings[idx] = { ...b, checkedInAt: null }
  db['adoga_bookings'] = bookings
}

// "เสร็จสิ้น" เป็นสถานะสุดท้ายตาม State Diagram การจอง จึงย้อนกลับไม่ได้
export function revertToCheckIn() {
  fail('การเข้าพักที่เช็คเอาท์แล้ว (เสร็จสิ้น) ไม่สามารถย้อนกลับได้')
}

export function checkOut(bookingId) {
  const bookings = [...list('adoga_bookings')]
  const idx = findIndexOrFail(bookings, bookingId, 'การจอง')
  const b = bookings[idx]
  if (b.status !== 'confirmed') fail('เช็คเอาท์ได้เฉพาะการจองที่ยืนยันแล้ว')
  if (!b.checkedInAt) fail('ต้องเช็คอินก่อนจึงจะเช็คเอาท์ได้')
  bookings[idx] = { ...transition('booking', b, 'completed'), checkedOutAt: new Date().toISOString() }
  const hotels = syncUnitStatuses(list('adoga_hotels'), bookings, [b])
  db['adoga_bookings'] = bookings
  db['adoga_hotels'] = hotels
}

// ── Refund ────────────────────────────────────────────────────────────────
export function isRefundEnabled() {
  const s = db['adoga_settings']
  return s ? s.enableRefund !== false : true
}

export function setRefundEnabled(enabled) {
  db['adoga_settings'] = { ...(db['adoga_settings'] || {}), enableRefund: !!enabled }
}

// เงื่อนไขขอคืนเงิน: ชำระเงินแล้ว, ยังไม่เช็คอิน, ยังไม่ถึงวันเข้าพัก (หรือวันเข้าพักวันนี้), ยังไม่เคยยื่น
export function refundBlockReason(b, userId, refunds = list('adoga_refunds')) {
  if (!isRefundEnabled()) return 'ระบบขอคืนเงินปิดให้บริการชั่วคราว'
  if (!b) return 'ไม่พบการจอง'
  if (userId && b.userId !== userId) return 'การจองนี้ไม่ใช่ของคุณ'
  if (b.status !== 'confirmed' || b.paymentStatus !== 'success') return 'ขอคืนเงินได้เฉพาะการจองที่ชำระเงินและยืนยันแล้ว'
  if (b.checkedInAt) return 'เข้าพักแล้ว ไม่สามารถขอคืนเงินได้'
  if (todayKey() > dayKey(b.checkIn)) return 'เลยวันเข้าพักแล้ว ไม่สามารถขอคืนเงินได้'
  if (refunds.some(r => r.bookingId === b.id)) return 'การจองนี้เคยยื่นขอคืนเงินแล้ว'
  return ''
}

export function requestRefund({ bookingId, userId, reason }) {
  const refunds = list('adoga_refunds')
  const b = list('adoga_bookings').find(x => x.id === bookingId)
  const block = refundBlockReason(b, userId, refunds)
  if (block) fail(block)
  if (!reason || !String(reason).trim()) fail('กรุณาระบุเหตุผลในการขอคืนเงิน')
  const refund = {
    id: nextSeqId(refunds.map(r => r.id), 'RF', 3),
    bookingId, userId, hotelId: b.hotelId, amount: b.totalPrice,
    reason: String(reason).trim(), status: 'submitted', rejectReason: null,
    createdAt: new Date().toISOString(), statusHistory: [],
  }
  db['adoga_refunds'] = [...refunds, refund]
  return refund
}

// ผู้พิจารณาคำขอคืนเงิน = ผู้จัดการของโรงแรมนั้น (ผู้ดูแลระบบดูได้อย่างเดียว)
function assertRefundDecider(refund, actorId) {
  if (!actorId) return
  const hotel = list('adoga_hotels').find(h => h.id === refund.hotelId)
  if (!hotel || hotel.managerId !== actorId) fail('เฉพาะผู้จัดการของโรงแรมนี้เท่านั้นที่พิจารณาคำขอคืนเงินได้')
}

export function startReview(refundId, actorId = null) {
  const refunds = [...list('adoga_refunds')]
  const idx = findIndexOrFail(refunds, refundId, 'คำขอคืนเงิน')
  assertRefundDecider(refunds[idx], actorId)
  refunds[idx] = transition('refund', refunds[idx], 'reviewing')
  db['adoga_refunds'] = refunds
}

function toDecision(refund, to) {
  let r = refund
  if (r.status === 'submitted') r = transition('refund', r, 'reviewing')
  return transition('refund', r, to)
}

export function approveRefund(refundId, actorId = null) {
  const refunds = [...list('adoga_refunds')]
  const rIdx = findIndexOrFail(refunds, refundId, 'คำขอคืนเงิน')
  assertRefundDecider(refunds[rIdx], actorId)
  const bookings = [...list('adoga_bookings')]
  const bIdx = findIndexOrFail(bookings, refunds[rIdx].bookingId, 'การจองของคำขอนี้')
  const b = bookings[bIdx]
  // ตรวจทุกเงื่อนไขก่อน แล้วค่อยเปลี่ยนข้อมูลทั้งชุดพร้อมกัน
  if (b.checkedInAt || !canTransition('booking', b, 'cancelled') || !canTransition('payment', b, 'refunded')) {
    fail('อนุมัติไม่ได้: การจองนี้เข้าพักแล้ว ยกเลิกแล้ว หรือยังไม่ได้ชำระเงิน')
  }
  const approved = toDecision(refunds[rIdx], 'approved')
  let nb = transition('booking', b, 'cancelled')
  nb = { ...transition('payment', nb, 'refunded'), cancelReason: 'refunded', refundedAt: new Date().toISOString() }
  refunds[rIdx] = { ...approved, decidedAt: new Date().toISOString() }
  bookings[bIdx] = nb
  const hotels = syncUnitStatuses(list('adoga_hotels'), bookings, [b])
  db['adoga_refunds'] = refunds
  db['adoga_bookings'] = bookings
  db['adoga_hotels'] = hotels
}

export function rejectRefund(refundId, rejectReason, actorId = null) {
  if (!rejectReason || !String(rejectReason).trim()) fail('กรุณาระบุเหตุผลการปฏิเสธ')
  const refunds = [...list('adoga_refunds')]
  const idx = findIndexOrFail(refunds, refundId, 'คำขอคืนเงิน')
  assertRefundDecider(refunds[idx], actorId)
  refunds[idx] = { ...toDecision(refunds[idx], 'rejected'), rejectReason: String(rejectReason).trim(), decidedAt: new Date().toISOString() }
  db['adoga_refunds'] = refunds
}

// ── Hotel ─────────────────────────────────────────────────────────────────
const HOTEL_LABEL = { pending: 'รออนุมัติ', approved: 'เปิดใช้งาน', rejected: 'ถูกปฏิเสธ', suspended: 'ปิดชั่วคราว', closed: 'ปิดกิจการ' }

function hotelLog(editorId, action, status, changes) {
  return { id: 'LOG-' + Date.now() + '-' + Math.floor(Math.random() * 1000), at: new Date().toISOString(), editorId, action, status, changes }
}

function changeHotelStatus(hotelId, to, { action, editorId, extra = {}, extraChanges = [] } = {}) {
  const hotels = [...list('adoga_hotels')]
  const idx = findIndexOrFail(hotels, hotelId, 'โรงแรม')
  const prev = hotels[idx]
  let h = transition('hotel', prev, to)
  if (action) {
    const log = hotelLog(editorId, action, to, [
      { field: 'สถานะโรงแรม', from: `${HOTEL_LABEL[prev.status]} (${prev.status})`, to: `${HOTEL_LABEL[to]} (${to})` },
      ...extraChanges,
    ])
    h = { ...h, editLogs: [log, ...(prev.editLogs || [])] }
  }
  hotels[idx] = { ...h, ...extra }
  db['adoga_hotels'] = hotels
  return hotels[idx]
}

export function approveHotel(hotelId, adminId = 'A001') {
  return changeHotelStatus(hotelId, 'approved', { action: 'อนุมัติโรงแรมเรียบร้อยแล้ว', editorId: adminId, extra: { rejectReason: null } })
}

export function rejectHotel(hotelId, rejectReason, adminId = 'A001') {
  if (!rejectReason || !String(rejectReason).trim()) fail('กรุณาระบุเหตุผลการปฏิเสธ')
  const reason = String(rejectReason).trim()
  return changeHotelStatus(hotelId, 'rejected', {
    action: 'ปฏิเสธคำขอของโรงแรม', editorId: adminId, extra: { rejectReason: reason },
    extraChanges: [{ field: 'เหตุผลการปฏิเสธ', from: '-', to: reason }],
  })
}

export function suspendHotel(hotelId) {
  return changeHotelStatus(hotelId, 'suspended')
}

export function activateHotel(hotelId) {
  const h = list('adoga_hotels').find(x => x.id === hotelId)
  if (!h) fail('ไม่พบโรงแรม')
  if (h.status !== 'suspended') fail('เปิดรับจองใหม่ได้เฉพาะโรงแรมที่ปิดชั่วคราว')
  return changeHotelStatus(hotelId, 'approved')
}

export function closeHotel(hotelId) {
  const active = list('adoga_bookings').filter(b => b.hotelId === hotelId && isActiveBooking(b))
  if (active.length) fail(`ยังมีการจองที่ค้างอยู่ ${active.length} รายการ ต้องจัดการให้เสร็จก่อนปิดกิจการ`)
  return changeHotelStatus(hotelId, 'closed', { action: 'ปิดกิจการโรงแรม', editorId: list('adoga_hotels').find(x => x.id === hotelId)?.managerId })
}

// Normalise the rooms coming from the manager form.
// Unit statuses always come from the database (never from the form) so a stale form can't
// free a booked unit; new units start as "available".
function normaliseRooms(hotelId, formRooms, prevRooms = [], bookings = []) {
  if (!Array.isArray(formRooms) || !formRooms.length) fail('โรงแรมต้องมีประเภทห้องพักอย่างน้อย 1 ประเภท')
  const prevById = new Map(prevRooms.map(r => [r.id, r]))
  let seq = prevRooms.reduce((m, r) => {
    const mm = /-R(\d+)$/.exec(r.id || '')
    return mm ? Math.max(m, parseInt(mm[1], 10)) : m
  }, 0)
  const seenNos = new Set()
  const rooms = formRooms.map(fr => {
    const type = String(fr.type || '').trim()
    if (!type) fail('กรุณาระบุชื่อประเภทห้องพัก')
    const price = Number(fr.price)
    if (!(price > 0)) fail(`ราคาของห้อง "${type}" ไม่ถูกต้อง`)
    const capacity = Math.max(1, Math.floor(Number(fr.capacity) || 1))
    const prev = prevById.get(fr.id)
    const id = prev ? prev.id : `${hotelId}-R${++seq}`
    const prevUnits = new Map((prev?.units || []).map(u => [String(u.no), u]))
    const units = (fr.units || []).map(u => {
      const no = String(u.no || '').trim()
      if (!no) fail('หมายเลขห้องต้องไม่ว่าง')
      if (seenNos.has(no)) fail(`หมายเลขห้อง ${no} ซ้ำกันในโรงแรมเดียวกัน`)
      seenNos.add(no)
      return prevUnits.get(no) || { no, status: 'available', statusHistory: [] }
    })
    if (!units.length) fail(`ห้อง "${type}" ต้องมีห้องพักอย่างน้อย 1 ห้อง`)
    return { ...(prev || {}), id, type, price, capacity, units }
  })
  // Removing a room type / unit that still has active bookings is not allowed
  for (const pr of prevRooms) {
    const nr = rooms.find(r => r.id === pr.id)
    for (const u of pr.units || []) {
      const stillThere = nr && nr.units.some(x => String(x.no) === String(u.no))
      if (!stillThere && unitHasActiveBooking(bookings, hotelId, pr.id, u.no)) {
        fail(`ลบห้อง ${u.no} (${pr.type}) ไม่ได้ เพราะยังมีการจองที่ค้างอยู่`)
      }
    }
  }
  return rooms
}

function cleanHotelFields(data) {
  const name = String(data.name || '').trim()
  const location = String(data.location || '').trim()
  if (!name || !location) fail('กรุณากรอกชื่อและทำเลที่ตั้ง')
  const pricePerNight = Number(data.pricePerNight)
  if (!(pricePerNight > 0)) fail('ราคาเริ่มต้นต่อคืนไม่ถูกต้อง')
  const discount = Number(data.discount) || 0
  if (discount < 0 || discount > 90) fail('ส่วนลดต้องอยู่ระหว่าง 0–90%')
  return {
    name, location,
    description: String(data.description || '').trim(),
    pricePerNight, discount,
    amenities: Array.isArray(data.amenities) ? [...data.amenities] : [],
    images: Array.isArray(data.images) && data.images.length ? [...data.images] : ['https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800&q=80'],
  }
}

export function createHotel({ managerId, rooms, ...data }) {
  const hotels = list('adoga_hotels')
  const manager = list('adoga_users').find(u => u.id === managerId)
  if (!manager || manager.role !== 'manager') fail('ต้องเป็นบัญชีผู้จัดการโรงแรมเท่านั้น')
  // Business rule: 1 Manager = 1 Hotel (หากหลายสาขาให้อยู่ภายใต้โรงแรมเดียวกัน)
  if (hotels.some(h => h.managerId === managerId && h.status !== 'closed')) {
    fail('ผู้จัดการ 1 ท่านดูแลโรงแรมได้เพียง 1 แห่งเท่านั้น (หากมีหลายสาขา ให้เพิ่มเป็นสาขาภายในโรงแรมเดิม)')
  }
  const fields = cleanHotelFields(data)
  const id = nextSeqId(hotels.map(h => h.id), 'H', 3)
  const now = new Date().toISOString()
  const hotel = {
    id, managerId, ...fields,
    rating: null,
    rooms: normaliseRooms(id, rooms),
    status: 'pending',
    rejectReason: null,
    statusHistory: [{ entity: 'hotel', from: null, to: 'pending', at: now }],
    createdAt: now,
    editLogs: [hotelLog(managerId, 'ส่งขอเปิดโรงแรมครั้งแรก (สร้างข้อมูลใหม่)', 'pending', [
      { field: 'การดำเนินการ', from: '-', to: 'สร้างโพสต์โรงแรมและส่งขออนุมัติ' },
      { field: 'ราคาเริ่มต้น/คืน', from: '-', to: `฿${fields.pricePerNight}` },
      { field: 'ทำเลที่ตั้ง', from: '-', to: fields.location },
    ])],
  }
  db['adoga_hotels'] = [...hotels, hotel]
  return hotel
}

export function updateHotel(hotelId, data) {
  const hotels = [...list('adoga_hotels')]
  const idx = findIndexOrFail(hotels, hotelId, 'โรงแรม')
  const prev = hotels[idx]
  if (prev.status === 'closed') fail('โรงแรมปิดกิจการแล้ว ไม่สามารถแก้ไขข้อมูลได้')
  if (prev.status === 'suspended') fail('กรุณาเปิดรับจองโรงแรมก่อน จึงจะแก้ไขข้อมูลและส่งตรวจสอบได้')

  const fields = cleanHotelFields({ ...prev, ...data })
  const rooms = normaliseRooms(hotelId, data.rooms || prev.rooms, prev.rooms || [], list('adoga_bookings'))

  const changes = []
  if (fields.name !== prev.name) changes.push({ field: 'ชื่อโรงแรม', from: prev.name, to: fields.name })
  if (fields.location !== prev.location) changes.push({ field: 'ทำเลที่ตั้ง', from: prev.location, to: fields.location })
  if (fields.pricePerNight !== Number(prev.pricePerNight)) changes.push({ field: 'ราคาเริ่มต้น/คืน', from: `฿${prev.pricePerNight}`, to: `฿${fields.pricePerNight}` })
  if (fields.discount !== (Number(prev.discount) || 0)) changes.push({ field: 'ส่วนลด', from: `${prev.discount || 0}%`, to: `${fields.discount}%` })
  if (fields.description !== (prev.description || '')) changes.push({ field: 'รายละเอียดที่พัก', from: prev.description ? 'ข้อมูลเดิม' : 'ไม่มี', to: fields.description })
  if (JSON.stringify(fields.amenities) !== JSON.stringify(prev.amenities || [])) changes.push({ field: 'สิ่งอำนวยความสะดวก', from: (prev.amenities || []).join(', ') || 'ไม่มี', to: fields.amenities.join(', ') })
  if (JSON.stringify(fields.images) !== JSON.stringify(prev.images || [])) changes.push({ field: 'รูปภาพโรงแรม', from: `${prev.images?.length || 0} รูป`, to: `${fields.images.length} รูป` })
  const roomSig = (rs) => JSON.stringify((rs || []).map(r => [r.id, r.type, r.price, r.capacity, (r.units || []).map(u => String(u.no))]))
  if (roomSig(rooms) !== roomSig(prev.rooms)) {
    const count = (rs) => (rs || []).reduce((s, r) => s + (r.units?.length || 0), 0)
    changes.push({ field: 'ห้องพักและจำนวนห้อง', from: `${prev.rooms?.length || 0} ประเภท (${count(prev.rooms)} ห้อง)`, to: `${rooms.length} ประเภท (${count(rooms)} ห้อง)` })
  }
  if (!changes.length) fail('ไม่มีข้อมูลที่เปลี่ยนแปลง')

  let h = { ...prev, ...fields, rooms }
  // State Diagram โรงแรม: แก้ไขข้อมูลจาก "เปิดใช้งาน" หรือ "ถูกปฏิเสธ" → กลับไป "รออนุมัติ"
  if (prev.status === 'approved' || prev.status === 'rejected') h = transition('hotel', h, 'pending')
  h.rejectReason = null
  h.editLogs = [hotelLog(prev.managerId, 'ส่งคำขอแก้ไขข้อมูลโรงแรมและห้องพัก', 'pending', changes), ...(prev.editLogs || [])]
  hotels[idx] = h
  db['adoga_hotels'] = hotels
  return h
}

// ── Room units (ปิดปรับปรุง / พร้อมใช้งาน) ──────────────────────────────────
function changeUnit(hotelId, roomId, roomNo, to) {
  const hotels = [...list('adoga_hotels')]
  const hIdx = findIndexOrFail(hotels, hotelId, 'โรงแรม')
  const hotel = hotels[hIdx]
  const room = hotel.rooms?.find(r => r.id === roomId)
  const unit = room?.units?.find(u => String(u.no) === String(roomNo))
  if (!unit) fail('ไม่พบห้องพัก')
  if (to === 'maintenance' && unitHasActiveBooking(list('adoga_bookings'), hotelId, roomId, roomNo)) {
    fail('ห้องนี้มีการจองค้างอยู่ จึงปิดปรับปรุงไม่ได้')
  }
  const nextUnit = transition('room', unit, to)
  hotels[hIdx] = {
    ...hotel,
    rooms: hotel.rooms.map(r => r.id !== roomId ? r : { ...r, units: r.units.map(u => String(u.no) === String(roomNo) ? nextUnit : u) }),
  }
  db['adoga_hotels'] = hotels
}

export function setUnitMaintenance(hotelId, roomId, roomNo) {
  changeUnit(hotelId, roomId, roomNo, 'maintenance')
}

export function setUnitAvailable(hotelId, roomId, roomNo) {
  changeUnit(hotelId, roomId, roomNo, 'available')
}
