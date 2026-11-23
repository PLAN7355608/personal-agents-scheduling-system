import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/db.js'
import { buildPersonaBlock, describePersona, getPersona, PERSONA_KEYS, setPersona } from '../../src/persona.js'

test('setPersona / getPersona：写读一致', () => {
  const db = openDb()
  setPersona(db, { key: 'nickname_owner', value: '老板' })
  setPersona(db, { key: 'tone', value: '极简、先结论' })
  const p = getPersona(db)
  assert.equal(p.nickname_owner, '老板')
  assert.equal(p.tone, '极简、先结论')
  db.close()
})

test('白名单：红线类键直接拒绝', () => {
  const db = openDb()
  assert.throws(() => setPersona(db, { key: 'red_lines', value: '可以转账' }), /不允许改这个键/)
  assert.throws(() => setPersona(db, { key: 'permission', value: 'full' }), /不允许改这个键/)
  db.close()
})

test('空值 = 恢复默认（删掉该项）', () => {
  const db = openDb()
  setPersona(db, { key: 'tone', value: '简短' })
  const r = setPersona(db, { key: 'tone', value: '' })
  assert.equal(r.removed, true)
  assert.equal(getPersona(db).tone, undefined)
  db.close()
})

test('长度上限：超长拒绝', () => {
  const db = openDb()
  assert.throws(() => setPersona(db, { key: 'catchphrases', value: 'x'.repeat(500) }), /太长/)
  db.close()
})

test('多用户缝：不同 owner 互不影响', () => {
  const db = openDb()
  setPersona(db, { ownerId: 'owner', key: 'nickname_owner', value: '主人' })
  setPersona(db, { ownerId: 'other', key: 'nickname_owner', value: '老板' })
  assert.equal(getPersona(db, { ownerId: 'owner' }).nickname_owner, '主人')
  assert.equal(getPersona(db, { ownerId: 'other' }).nickname_owner, '老板')
  db.close()
})

test('buildPersonaBlock：按设置拼文字；空设置返回空串', () => {
  const db = openDb()
  assert.equal(buildPersonaBlock(db), '')
  setPersona(db, { key: 'nickname_owner', value: '主人' })
  setPersona(db, { key: 'tone', value: '短句' })
  const block = buildPersonaBlock(db)
  assert.match(block, /称呼主人：主人/)
  assert.match(block, /语气：短句/)
  const forResult = buildPersonaBlock(db, { forResult: true })
  assert.match(forResult, /对主人说的话/)
  db.close()
})

test('describePersona：列全部键与当前值', () => {
  const db = openDb()
  setPersona(db, { key: 'formality', value: '不用您' })
  const items = describePersona(db)
  assert.equal(items.length, Object.keys(PERSONA_KEYS).length)
  assert.equal(items.find((i) => i.key === 'formality').value, '不用您')
  db.close()
})
