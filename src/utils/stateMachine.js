// src/utils/stateMachine.js
// All transition rules — NEVER write x.status = '...' directly outside services/transitions.js
// แต่ละ map ตรงกับ State Diagram ในรายงาน (บทที่ 3.10)
export const TRANSITIONS = {
  // State Diagram 5 โรงแรม: รออนุมัติ → เปิดใช้งาน/ถูกปฏิเสธ, ถูกปฏิเสธ → รออนุมัติ (แก้ไข),
  // เปิดใช้งาน → รออนุมัติ (แก้ไขข้อมูล) / ปิดชั่วคราว / เสร็จสิ้น(ปิดกิจการ), ปิดชั่วคราว → เปิดใช้งาน
  hotel: {
    pending:   ['approved', 'rejected'],
    approved:  ['pending', 'suspended', 'closed'],
    rejected:  ['pending'],
    suspended: ['approved'],
    closed:    [],
  },
  // State Diagram 2 ห้องพัก: ว่าง ↔ ถูกจอง, ว่าง ↔ ปิดปรับปรุง
  room: {
    available:   ['booked', 'maintenance'],
    booked:      ['available'],
    maintenance: ['available'],
  },
  // State Diagram 4 การจอง: รอชำระเงิน → ยืนยันแล้ว/ยกเลิก, ยืนยันแล้ว → ยกเลิก/เสร็จสิ้น
  booking: {
    pending_payment: ['confirmed', 'cancelled'],
    confirmed:       ['completed', 'cancelled'],
    completed:       [],
    cancelled:       [],
  },
  // State Diagram 3 การชำระเงิน: รอชำระ → รอตรวจสอบ → สำเร็จ/ล้มเหลว,
  // ล้มเหลว → รอชำระ (ชำระใหม่), สำเร็จ → คืนเงินแล้ว
  payment: {
    awaiting:  ['verifying'],
    verifying: ['success', 'failed'],
    failed:    ['awaiting'],
    success:   ['refunded'],
    refunded:  [],
  },
  // State Diagram 1 ใบขอคืนเงิน: ถูกยื่น → กำลังตรวจสอบ → อนุมัติ/ปฏิเสธ
  refund: {
    submitted: ['reviewing'],
    reviewing: ['approved', 'rejected'],
    approved:  [],
    rejected:  [],
  },
}

function currentOf(entity, record) {
  return entity === 'payment' ? (record.paymentStatus || record.status) : record.status
}

export function canTransition(entity, record, to) {
  const allowed = TRANSITIONS[entity]?.[currentOf(entity, record)] ?? []
  return allowed.includes(to)
}

// Returns a NEW record with the status changed (the input is never mutated),
// or throws when the transition is not allowed by the diagram.
export function transition(entity, record, to) {
  const from = currentOf(entity, record)
  if (!canTransition(entity, record, to)) {
    throw new Error(`[StateMachine] Invalid transition: ${entity} ${from} → ${to}`)
  }
  const next = { ...record }
  next.statusHistory = [...(record.statusHistory || []), { entity, from, to, at: new Date().toISOString() }]
  if (entity === 'payment') next.paymentStatus = to
  else next.status = to
  return next
}
