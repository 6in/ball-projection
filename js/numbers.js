// ボール番号の割り当て。1 セットの中で番号は重複しないので、
// 全ボールの候補を確率の高い順に見て、未使用の番号から確定していく。
//   candidates[i]: [{ n, p }, ...]  (ボール i の候補)
//   戻り値: [{ n, p }]  (n = -1 は不明)
export function assignNumbers(candidates, unique = true) {
  if (!unique) return candidates.map((c) => best(c));
  const pairs = [];
  candidates.forEach((cs, i) => cs.forEach((c) => pairs.push({ i, ...c })));
  pairs.sort((a, b) => b.p - a.p);
  const result = candidates.map(() => null);
  const used = new Set();
  for (const { i, n, p } of pairs) {
    if (result[i] || used.has(n)) continue;
    result[i] = { n, p };
    used.add(n);
  }
  return result.map((r) => r || { n: -1, p: 0 });
}

function best(cs) {
  return cs.reduce((a, c) => (c.p > a.p ? c : a), { n: -1, p: 0 });
}
