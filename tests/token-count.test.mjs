import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import { createTokenCounter } from '../src/vector/token-count.mjs';

// 第 2 步守卫的 token 计数：真 tokenizer（bge-m3，本地缓存）算 token 数；加载不到退回保守字数估算。
// 断言对「真 tokenizer」和「字数兜底」都成立——离线也不挂。
test('token 计数器：空串 0、串越长 token 越多', async () => {
  const counter = createTokenCounter({ modelName: 'Xenova/bge-m3' });
  assert.equal(await counter.count(''), 0, '空串 0 token');
  const n = await counter.count('你好世界，这是一个条件树测试节点。');
  assert.ok(n > 0, `非空串得正 token 数（${n}）`);
  const short = await counter.count('短句');
  const long = await counter.count('这是一个明显更长、包含更多字符的句子，应当得到更多 token 数目。');
  assert.ok(long > short, `长串 token(${long}) > 短串 token(${short})`);
});
