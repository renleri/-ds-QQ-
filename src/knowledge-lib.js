// 角色知识库（世界观设定集）。
//
// 为什么单独做一个模块：人设文件（roles/*.md）每轮都会整段注入，把整套作品设定塞进去
// 会白烧上下文；而「她该知道邦邦」这种需求，正确形态是——
//   1) 永远给一份**目录**（有哪些乐队、各有哪些角色），让她知道自己知道什么；
//   2) 对话里出现角色名/乐队名时，才把那一段详情注入。
//
// 文件格式（knowledge/*.md，面向人手写，尽量宽松）：
//
//   # Bang Dream!（邦邦）
//   ## Poppin'Party
//   关键词：邦邦, Poppin'Party, ポピパ, 破琵琶
//   乐队简介……（任意 markdown，可省）
//   ### 戸山香澄（Toyama Kasumi／户山香澄）
//   关键词：香澄, Kasumi, 户山香澄
//   - CV：愛美
//   - 担当：主唱 & 吉他
//
// `## ` = 乐队（一级条目），`### ` = 角色（二级条目）。「关键词：」行用来匹配对话，
// 不在正文里重复出现。标题括号里的斜杠分隔写法会自动变成别名，方便中日英混着叫。
import fs from 'node:fs';
import path from 'node:path';

const KEYWORD_LINE = /^\s*(?:关键词|關鍵詞|keywords?)\s*[:：]\s*(.+?)\s*$/i;
const BAND_HEADING = /^##\s+(?!#)(.+?)\s*$/;
const MEMBER_HEADING = /^###\s+(.+?)\s*$/;
const DOC_HEADING = /^#\s+(?!#)(.+?)\s*$/;
/** 别名太短会误伤（「蘭」会命中「荷兰」），所以自动别名至少 2 个字，单字请手写进「关键词：」。 */
const MIN_AUTO_ALIAS_LEN = 2;
/**
 * 单字关键词的前置字黑名单。中文没法用词边界，单字名最容易被国名/译名误伤：
 * 「美竹蘭」的「蘭」会命中「荷兰 / 波兰 / 乌克兰」。写进「关键词：」的单字默认生效，
 * 但只要前一个字在这张表里就判定为误伤。
 */
const SINGLE_CHAR_BLOCK_PREV = new Set('荷波乌爱芬苏格法锡纽英新丹瑞以意奥亚澳加挪捷'.split(''));

/** 单字关键词的匹配：先看前置字是否踩雷。 */
function matchSingleChar(hay, kw) {
  const needle = kw.toLowerCase();
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) return false;
    if (idx === 0) return true;
    const prev = hay[idx - 1];
    if (!SINGLE_CHAR_BLOCK_PREV.has(prev)) return true;
    from = idx + 1;
  }
}

function splitKeywords(raw) {
  return String(raw ?? '')
    .split(/[,，、/／|｜]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 从标题里拆出主名与别名：「戸山香澄（Toyama Kasumi／户山香澄）」→ 三个名字。 */
function aliasesFromHeading(heading) {
  const out = [];
  const outer = String(heading).replace(/[（(]([^（）()]*)[）)]/g, (_, inner) => {
    for (const part of inner.split(/[／/、,，]/)) {
      const t = part.trim();
      if (t) out.push(t);
    }
    return ' ';
  });
  const main = outer.replace(/\s+/g, ' ').trim();
  if (main) out.unshift(main);
  return [...new Set(out.filter(Boolean))];
}

function normalizeEntry(name, keywords, body) {
  const aliases = aliasesFromHeading(name).filter((a) => a.length >= MIN_AUTO_ALIAS_LEN);
  const curated = splitKeywords(keywords);
  const match = [...new Set([...aliases, ...curated])];
  return { name: String(name).trim(), aliases, keywords: curated, match, body: String(body ?? '').trim() };
}

/** 解析一份知识文档。返回 { source, title, bands: [...] }。 */
export function parseKnowledge(text, source = '') {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const bands = [];
  let title = path.basename(source || 'knowledge', '.md');
  let band = null;
  let member = null;
  let buffer = [];
  let pendingKeywords = '';

  const flushMember = () => {
    if (!member) return;
    const entry = normalizeEntry(member.name, pendingKeywords, buffer.join('\n'));
    if (entry.body || entry.keywords.length) band.members.push(entry);
    member = null;
    buffer = [];
    pendingKeywords = '';
  };
  const flushBand = () => {
    flushMember();
    if (band) {
      // 乐队简介：写在没有成员的那段里；若无成员则整段就是简介（别串进角色资料）。
      band.intro = band.intro || buffer.join('\n').trim();
      band.match = [...new Set([...splitKeywords(pendingKeywords), ...aliasesFromHeading(band.name).filter((a) => a.length >= MIN_AUTO_ALIAS_LEN)])];
      if (band.name) bands.push(band);
    }
    band = null;
    buffer = [];
    pendingKeywords = '';
  };

  for (const line of lines) {
    const bandMatch = BAND_HEADING.exec(line);
    const memberMatch = MEMBER_HEADING.exec(line);
    const docMatch = DOC_HEADING.exec(line);
    if (bandMatch) {
      flushBand();
      band = { name: bandMatch[1], keywords: [], match: [], intro: '', members: [], source };
      continue;
    }
    if (memberMatch) {
      if (!band) continue;
      flushMember();
      // flushMember 之后 buffer 里剩下的就是「成员出现之前的那段」，归乐队简介
      if (!band.intro) band.intro = buffer.join('\n').trim();
      buffer = [];
      member = { name: memberMatch[1] };
      continue;
    }
    if (docMatch && !band) {
      title = docMatch[1];
      continue;
    }
    const kw = KEYWORD_LINE.exec(line);
    if (kw) {
      if (member) pendingKeywords = pendingKeywords ? `${pendingKeywords},${kw[1]}` : kw[1];
      else if (band) band.keywords.push(...splitKeywords(kw[1]));
      continue;
    }
    buffer.push(line);
  }
  flushBand();
  return { source, title, bands: bands.filter((b) => b.name) };
}

/** 把目录下所有 .md 读成一个知识库。 */
export function loadKnowledgeDir(dir) {
  const kb = { dir, title: '', bands: [], loadedAt: 0, files: [] };
  let entries = [];
  try {
    // README.md 只写给人看（格式说明），不参与知识库
    entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'readme.md').sort();
  } catch {
    return kb;
  }
  for (const file of entries) {
    const full = path.join(dir, file);
    try {
      const doc = parseKnowledge(fs.readFileSync(full, 'utf8'), file);
      if (!kb.title && doc.title) kb.title = doc.title;
      kb.bands.push(...doc.bands);
      kb.files.push({ file, bands: doc.bands.length, mtimeMs: fs.statSync(full).mtimeMs });
    } catch {
      /* 单个文件坏掉不影响其它 */
    }
  }
  kb.loadedAt = Date.now();
  return kb;
}

/**
 * 带 mtime 缓存的读取：改完 knowledge/*.md 不用重启桥接，下一轮对话自动生效。
 */
export function createKnowledgeStore(dir) {
  let cache = loadKnowledgeDir(dir);
  const fingerprint = () => {
    try {
      return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'readme.md').sort()
        .map((f) => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`).join('|');
    } catch {
      return '';
    }
  };
  let fp = fingerprint();
  return {
    dir,
    reload() { cache = loadKnowledgeDir(dir); fp = fingerprint(); return cache; },
    get() {
      const now = fingerprint();
      if (now !== fp) { cache = loadKnowledgeDir(dir); fp = now; }
      return cache;
    },
  };
}

/** 目录：每个条目一行，列出角色名与担当（若正文里写了「担当：」）。 */
export function knowledgeIndex(kb, { maxChars = 1500 } = {}) {
  const rows = [];
  for (const band of kb?.bands ?? []) {
    // 没有角色的条目（企划入门、场所之类）只列标题，别留个空冒号
    if (!band.members.length) {
      rows.push(`- ${band.name}`);
      if (rows.join('\n').length > maxChars) break;
      continue;
    }
    const names = band.members.map((m) => {
      const duty = /担当\s*[:：]\s*(.+)/.exec(m.body)?.[1]?.split(/[（(]/)[0]?.trim();
      return duty ? `${m.name.split(/[（(]/)[0]}(${duty})` : m.name.split(/[（(]/)[0];
    });
    rows.push(`- ${band.name}：${names.join('、')}`);
    if (rows.join('\n').length > maxChars) break;
  }
  return rows.join('\n');
}

/** 在给定文本里找出命中的乐队/角色（长名字优先，避免「香澄」抢在「戸山香澄」前面）。 */
export function matchKnowledge(kb, text, { maxSections = 6 } = {}) {
  const hay = String(text ?? '').toLowerCase();
  if (!hay.trim()) return [];
  const hit = (kw) => (kw.length <= 1 ? matchSingleChar(hay, kw) : hay.includes(kw.toLowerCase()));
  const hits = [];
  for (const band of kb?.bands ?? []) {
    for (const kw of band.match ?? []) {
      if (kw && hit(kw)) { hits.push({ type: 'band', band, weight: kw.length }); break; }
    }
    for (const member of band.members) {
      for (const kw of member.match ?? []) {
        if (kw && hit(kw)) { hits.push({ type: 'member', band, member, weight: kw.length }); break; }
      }
    }
  }
  hits.sort((a, b) => b.weight - a.weight);
  const seen = new Set();
  const out = [];
  for (const hit of hits) {
    const id = hit.type === 'band' ? `band:${hit.band.name}` : `member:${hit.band.name}/${hit.member.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(hit);
    if (out.length >= maxSections) break;
  }
  return out;
}

/**
 * 拼出要注入 prompt 的知识块。
 * @param kb createKnowledgeStore().get() 的结果
 * @param text 触发文本（本轮消息 + 最近几条往来）
 */
export function buildKnowledgeContext(kb, text, { maxChars = 2500, maxSections = 6, alwaysIndex = true, header = '【你已知的作品资料】' } = {}) {
  const bands = kb?.bands ?? [];
  if (!bands.length) return '';
  const parts = [];
  if (alwaysIndex) {
    const index = knowledgeIndex(kb, { maxChars: Math.max(300, Math.floor(maxChars / 2)) });
    if (index) parts.push(`${header}（说到相关话题时按需引用，别没事背设定）\n${index}`);
  }
  const hits = matchKnowledge(kb, text, { maxSections });
  let used = parts.join('\n').length;
  const details = [];
  for (const hit of hits) {
    const chunk = hit.type === 'band'
      ? [`### ${hit.band.name}`, hit.band.intro].filter(Boolean).join('\n')
      : [`### ${hit.member.name}（${hit.band.name}）`, hit.member.body].filter(Boolean).join('\n');
    if (used + chunk.length > maxChars) break;
    used += chunk.length;
    details.push(chunk);
  }
  if (details.length) parts.push(`【本轮提到的角色/乐队资料】\n${details.join('\n\n')}`);
  return parts.join('\n\n');
}

/** 按名字查（给控制台/工具用，返回原文）。 */
export function queryKnowledge(kb, query, limit = 3) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const band of kb?.bands ?? []) {
    const bandHit = (band.match ?? []).some((kw) => kw.toLowerCase().includes(q)) || band.name.toLowerCase().includes(q);
    if (bandHit) out.push({ kind: 'band', band: band.name, text: [`## ${band.name}`, band.intro].filter(Boolean).join('\n') });
    for (const member of band.members) {
      const hit = (member.match ?? []).some((kw) => kw.toLowerCase().includes(q)) || member.name.toLowerCase().includes(q);
      if (hit) out.push({ kind: 'member', band: band.name, name: member.name, text: `### ${member.name}（${band.name}）\n${member.body}` });
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

export function knowledgeStats(kb) {
  const members = (kb?.bands ?? []).reduce((n, b) => n + b.members.length, 0);
  return { files: kb?.files?.length ?? 0, bands: kb?.bands?.length ?? 0, members };
}
