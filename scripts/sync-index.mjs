#!/usr/bin/env node
// 重算 src/bridge.js 顶部【功能索引】里的行号。
//
// 为什么需要它：索引块自己也在文件里，插一行就会把后面所有行号顶偏；手工改一次
// 就要重新 grep 一遍 30 多个函数（2026-09-18 已经手工踩过两次，第一次按 +55 算、
// 实际 +56，全表错了一行）。这个脚本把「查声明行 → 回填」自动化。
//
// 用法：node scripts/sync-index.mjs [--check]
//   --check  只报告差异，不写文件（CI/提交前用）
//
// 认声明行的规则（严格版，避免把函数调用当成声明）：
//   function NAME(...)  /  async function NAME(...)  /  const|let|var NAME = ...
//   不带这些前缀的（缩进的调用、属性访问）一律不算。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 兼容两种布局：仓库根就是项目根；或脚本放在 <workspace>/_tools 下（项目在 ../qq-bridge）。
const FILE = fs.existsSync(path.join(ROOT, 'src', 'bridge.js'))
  ? path.join(ROOT, 'src', 'bridge.js')
  : path.join(ROOT, 'qq-bridge', 'src', 'bridge.js');

if (!fs.existsSync(FILE)) {
  console.error(`找不到 bridge.js：${FILE}`);
  process.exit(2);
}

const checkOnly = process.argv.includes('--check');
const text = fs.readFileSync(FILE, 'utf8');
const lines = text.split(/\r?\n/);

// 1) 定位索引块
const startIdx = lines.findIndex((l) => l.includes('【功能索引】'));
if (startIdx < 0) { console.error('找不到【功能索引】块'); process.exit(2); }
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (/^\/\/ ─+$/.test(lines[i])) { endIdx = i; break; }
}
if (endIdx < 0) { console.error('找不到索引块结束线'); process.exit(2); }

// 2) 收集需要行号的函数名（索引里出现的）
const nameRe = /(\d+)(\s+)([A-Za-z_$][\w$]*)(\(\))?(?=\s|$)/g;
const wanted = new Map(); // name -> [索引行号...]
for (let i = startIdx; i <= endIdx; i++) {
  nameRe.lastIndex = 0;
  let m;
  while ((m = nameRe.exec(lines[i])) !== null) {
    const name = m[3];
    if (!wanted.has(name)) wanted.set(name, []);
    wanted.get(name).push(i);
  }
}

// 3) 在全文里找每个名字的声明行（取第一个；索引块自身在顶部，跳过）
function declLine(name) {
  const fRe = new RegExp(`^\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const vRe = new RegExp(`^\\s*(?:const|let|var)\\s+${name}\\s*=`);
  for (let i = endIdx + 1; i < lines.length; i++) {
    if (fRe.test(lines[i]) || vRe.test(lines[i])) return i + 1;
  }
  return null;
}

// 4) 回填（保持列宽：数字右对齐后补空格）
let changed = 0;
const report = [];
for (const [name, rows] of wanted) {
  const real = declLine(name);
  if (!real) { report.push(`  ⚠️  ${name}：找不到声明行，已跳过`); continue; }
  for (const i of rows) {
    const line = lines[i];
    nameRe.lastIndex = 0;
    const m = nameRe.exec(line);
    if (!m || m[3] !== name) continue;
    const oldNum = m[1];
    if (oldNum === String(real)) continue;
    const width = Math.max(oldNum.length, String(real).length);
    const pad = ' '.repeat(width - String(real).length);
    // 只替换第一次出现的「数字 + 空白 + 该函数名」片段，避免动到行内其它数字
    const at = line.indexOf(oldNum + m[2] + name, m.index);
    if (at < 0) continue;
    const replaced = line.slice(0, at) + pad + real + m[2] + name + line.slice(at + oldNum.length + m[2].length + name.length);
    lines[i] = replaced;
    changed++;
    report.push(`  ${name}: ${oldNum} → ${real}`);
  }
}

// 5) 更新「（NNNN+ 行）」
const total = lines.length;
const rounded = Math.floor(total / 100) * 100;
const hdrIdx = lines.findIndex((l, i) => i >= startIdx && i <= endIdx && /\d+\+\s*行/.test(l));
let hdrChanged = false;
if (hdrIdx >= 0) {
  const before = lines[hdrIdx];
  lines[hdrIdx] = before.replace(/\d+\+\s*行/, `${rounded}+ 行`);
  hdrChanged = lines[hdrIdx] !== before;
  if (hdrChanged) report.push(`  总行数说明 → ${rounded}+ 行（实际 ${total}）`);
}

const next = lines.join('\n');
if (!changed && !hdrChanged) {
  console.log(`✓ 索引已是最新（共 ${total} 行，${wanted.size} 个条目）`);
  process.exit(0);
}
console.log(`索引需要更新：${changed} 处行号${hdrChanged ? ' + 行数说明' : ''}`);
for (const r of report) console.log(r);
if (checkOnly) {
  console.log('（--check 模式，未写入）');
  process.exit(1);
}
fs.writeFileSync(FILE, next, 'utf8');
console.log(`✓ 已写回 ${FILE}`);
