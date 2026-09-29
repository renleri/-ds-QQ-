// 把 ~/.dsh/.agent-presets 下的 QQ 预设转成 DSH 的 bundle patch。
//
// 背景（2026-09-29）：DSH 重启后桥接报
//   resume failed: Unknown agent preset: qq-chat-v2
// 查下来：预设文件确实在 ~/.dsh/.agent-presets/qq-chat-v2/，但**当前 DSH 不读这个目录**
// （整个安装包里搜不到 .agent-presets 这个路径）。官方的 preset 注册方式是
// 在 profile patch 里 insert 一个 `@deepseek-ai/dsh-agent-preset` entry，
// 它的 config.plugins 就是一份 Loader entry 列表 —— 正好等于 agent.cordis.yml 的内容。
//
// 于是这里做「格式转换」而不是重写内容：把 agent.cordis.yml 原样嵌进 plugins，
// 只把 `name: ./xxx.mjs` 这种相对预设目录的路径换成 file:// URL
// （patch 里的相对路径不再以预设目录为基准，会解析不到）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = path.join(os.homedir(), '.dsh', '.agent-presets');
const OUT = process.argv[2] || 'D:/肥鱼的工作区/qq-bridge/dsh-plugin/qq-chat-presets';
const PRESETS = ['qq-chat-v2', 'qq-chat'];

/** preset.yml 只有 name/description/order 这几个扁平字段，不值得引入 YAML 依赖。 */
function parseFlatYml(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** 统一缩进；空行保持空（不补尾随空格）。 */
function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() === '' ? '' : pad + line))
    .join('\n');
}

const blocks = [];
const summary = [];

for (const id of PRESETS) {
  const dir = path.join(SRC, id);
  if (!fs.existsSync(dir)) {
    summary.push(`  ✗ ${id}: 目录不存在（${dir}）`);
    continue;
  }
  const meta = parseFlatYml(fs.readFileSync(path.join(dir, 'preset.yml'), 'utf8'));
  let comp = fs.readFileSync(path.join(dir, 'agent.cordis.yml'), 'utf8');

  // name: ./xxx.mjs → file:///<绝对路径>（正斜杠，Windows 也认）
  let replaced = 0;
  comp = comp.replace(/name:(\s*)\.\/([\w.-]+)/g, (_all, _sp, file) => {
    const abs = path.join(dir, file).replace(/\\/g, '/');
    replaced += 1;
    return `name: ${JSON.stringify(`file:///${abs}`)}`;
  });

  blocks.push(
    `- insert:
    - id: preset-${id}
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ${JSON.stringify(id)}
        name: ${JSON.stringify(meta.name ?? id)}
        description: ${JSON.stringify(meta.description ?? '')}
        order: ${Number.isFinite(Number(meta.order)) ? Number(meta.order) : 10}
        plugins:
${indent(comp, 10)}`,
  );
  summary.push(`  ✓ ${id}: order=${meta.order ?? 10}  本地路径替换 ${replaced} 处  (${meta.name ?? id})`);
}

const header = `# 自动生成 —— 由 _tools/build-preset-bundle.mjs 从 ~/.dsh/.agent-presets/ 生成。
# 不要手改：改预设请改源目录，然后重新跑生成脚本（再 install_bundle 一次）。
#
# 为什么需要这个 bundle：当前 DSH 不再扫描 ~/.dsh/.agent-presets/，
# 而桥接按 agentPreset=qq-chat-v2 建会话，缺了它 resume 会直接失败
# （gateway/internal: Unknown agent preset）。这里把两个 QQ 预设注册进 profile。

`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'cordis.patch.yml'), header + blocks.join('\n'), 'utf8');

console.log('生成结果:');
for (const line of summary) console.log(line);
console.log(`\n输出: ${path.join(OUT, 'cordis.patch.yml')}`);
