import { expect, it } from 'vitest'
import { csvLine, escapeCsvField } from '../backend/src/csv'

it('neutralises spreadsheet formulas and quotes special characters', () => {
  expect(escapeCsvField('=1+1')).toBe(`'=1+1`)
  expect(escapeCsvField('+1')).toBe(`'+1`)
  expect(escapeCsvField('-1')).toBe(`'-1`)
  expect(escapeCsvField('@cmd')).toBe(`'@cmd`)
  expect(escapeCsvField('safe,value')).toBe('"safe,value"')
  expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
  expect(csvLine(['NW-1', '=cmd'])).toBe("NW-1,'=cmd\n")
})
