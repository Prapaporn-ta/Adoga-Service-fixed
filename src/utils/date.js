// src/utils/date.js
export const now = () => new Date()
export const addHours = (n) => { const d = new Date(); d.setTime(d.getTime() + n * 3600000); return d }
export const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d }

export function formatDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDateTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function formatPrice(amount) {
  return new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 }).format(amount)
}

export function countdown(expiresAt) {
  const diff = new Date(expiresAt) - new Date()
  if (diff <= 0) return { expired: true, text: '00:00:00', urgent: true }
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  const s = Math.floor((diff % 60000) / 1000)
  const pad = n => String(n).padStart(2, '0')
  return {
    expired: false,
    text: `${pad(h)}:${pad(m)}:${pad(s)}`,
    urgent: diff <= 15 * 60 * 1000,
    warn: diff <= 2 * 3600000,
  }
}

// อ่านจำนวนเงินเป็นตัวอักษรไทย เช่น 2501 → "สองพันห้าร้อยเอ็ดบาทถ้วน", 12000000 → "สิบสองล้านบาทถ้วน"
export function thaiBahtText(amount) {
  const n = Math.round(Number(amount))
  if (!isFinite(n) || n === 0) return 'ศูนย์บาทถ้วน'
  const digits = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า']
  const places = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน']
  // read a number below one million
  const readGroup = (str, hasHigher = false) => {
    let out = ''
    const len = str.length
    for (let i = 0; i < len; i++) {
      const d = Number(str[i])
      const pos = len - i - 1
      if (d === 0) continue
      if (pos === 1 && d === 1) out += 'สิบ'
      else if (pos === 1 && d === 2) out += 'ยี่สิบ'
      else if (pos === 0 && d === 1 && (hasHigher || (len > 1 && Number(str.slice(0, -1)) > 0))) out += 'เอ็ด'
      else out += digits[d] + places[pos]
    }
    return out
  }
  const read = (num) => {
    const str = String(num)
    if (str.length <= 6) return readGroup(str)
    const head = str.slice(0, -6)
    const tail = str.slice(-6)
    return read(Number(head)) + 'ล้าน' + (Number(tail) ? readGroup(String(Number(tail)), true) : '')
  }
  return (n < 0 ? 'ลบ' : '') + read(Math.abs(n)) + 'บาทถ้วน'
}
