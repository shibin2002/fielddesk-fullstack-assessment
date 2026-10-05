export function escapeCsvField(value: unknown): string {
  let text = ''
  if (value == null) text = ''
  else if (value instanceof Date) text = value.toISOString()
  else text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`
  return text
}

export function csvLine(values: unknown[]): string {
  return `${values.map((value) => escapeCsvField(value)).join(',')}\n`
}
