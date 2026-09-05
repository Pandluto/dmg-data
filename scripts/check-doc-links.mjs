import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.join(repositoryRoot, 'docs');
const requiredEntryPoints = [
  'README.md',
  'docs/README.md',
  'docs/architecture/README.md',
  'docs/architecture/documentation-system.md',
  'docs/architecture/decisions/README.md',
  'docs/specs/README.md',
  'docs/evidence/README.md',
  'docs/evidence/current-snapshot.md',
  'docs/testing/README.md',
  'docs/research/README.md',
  'docs/guides/README.md',
  'docs/guides/development.md',
  'docs/maintenance/README.md',
  'docs/maintenance/documentation-cleanup-20260828.md',
  'docs/maintenance/development-history.md',
  'docs/archive/README.md'
];

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectCurrentMarkdown(directory, output = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(repositoryRoot, absolutePath);
    if (entry.isDirectory()) {
      if (relativePath === 'docs/archive') {
        const archiveIndex = path.join(absolutePath, 'README.md');
        if (await exists(archiveIndex)) output.push(archiveIndex);
        continue;
      }
      await collectCurrentMarkdown(absolutePath, output);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) output.push(absolutePath);
  }
  return output;
}

function removeFencedCode(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, '');
}

function linkTarget(rawTarget) {
  const target = rawTarget.trim();
  if (target.startsWith('<')) {
    const closing = target.indexOf('>');
    return closing === -1 ? target : target.slice(1, closing);
  }
  return target.split(/\s+["']/u, 1)[0].replace(/\\([ ()])/gu, '$1');
}

function isExternalOrAnchor(target) {
  return target.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target);
}

const errors = [];
for (const entryPoint of requiredEntryPoints) {
  if (!(await exists(path.join(repositoryRoot, entryPoint)))) {
    errors.push(`缺少文档入口: ${entryPoint}`);
  }
}

const topLevelEntries = await readdir(docsRoot, { withFileTypes: true });
const allowedTopLevelDirectories = new Set([
  'architecture', 'archive', 'evidence', 'guides', 'knowledge', 'maintenance', 'research', 'specs', 'testing'
]);
for (const entry of topLevelEntries) {
  if (entry.isFile() && /^\d{2}-.*\.md$/u.test(entry.name)) {
    errors.push(`编号历史文档仍在 docs 顶层: docs/${entry.name}`);
  }
  if (entry.isDirectory() && !allowedTopLevelDirectories.has(entry.name)) {
    errors.push(`未定义责任的 docs 顶层目录: docs/${entry.name}`);
  }
  if (entry.isFile() && entry.name !== 'README.md') {
    errors.push(`docs 顶层只允许 README.md: docs/${entry.name}`);
  }
}

const markdownFiles = [
  path.join(repositoryRoot, 'README.md'),
  path.join(repositoryRoot, 'AGENTS.md'),
  path.join(repositoryRoot, 'CONTEXT.md'),
  path.join(repositoryRoot, 'H.MD'),
  path.join(repositoryRoot, 'NOTICE.md'),
  ...(await collectCurrentMarkdown(docsRoot))
].filter((filePath, index, files) => files.indexOf(filePath) === index && filePath && path.extname(filePath) === '.md');

let checkedLinks = 0;
const markdownLink = /!?\[[^\]\n]*\]\(([^)\n]+)\)/gu;
for (const markdownFile of markdownFiles) {
  if (!(await exists(markdownFile))) continue;
  const rawMarkdown = await readFile(markdownFile, 'utf8');
  const markdown = removeFencedCode(rawMarkdown);
  const relativeMarkdown = path.relative(repositoryRoot, markdownFile).replaceAll('\\', '/');
  const h1Count = [...markdown.matchAll(/^# [^#].*$/gmu)].length;
  if (h1Count !== 1) errors.push(`${relativeMarkdown}: 必须且只能包含一个 H1，当前 ${h1Count}`);

  if (relativeMarkdown.startsWith('docs/specs/') && relativeMarkdown.endsWith('/spec.md')) {
    if (!/^\*\*Status:\*\*\s+\S+/mu.test(markdown)) {
      errors.push(`${relativeMarkdown}: Spec 缺少 **Status:**`);
    }
    for (const section of [
      'Problem Statement', 'Solution', 'User Stories', 'Implementation Decisions',
      'Testing Decisions', 'Out of Scope', 'Further Notes'
    ]) {
      if (!markdown.includes(`## ${section}`)) errors.push(`${relativeMarkdown}: Spec 缺少 ## ${section}`);
    }
  }

  if (/^docs\/architecture\/decisions\/\d{4}-.*\.md$/u.test(relativeMarkdown)) {
    if (!/^\*\*Status:\*\*\s+\S+/mu.test(markdown)) {
      errors.push(`${relativeMarkdown}: ADR 缺少 **Status:**`);
    }
    for (const section of ['Context', 'Decision', 'Consequences', 'Evidence']) {
      if (!markdown.includes(`## ${section}`)) errors.push(`${relativeMarkdown}: ADR 缺少 ## ${section}`);
    }
  }

  if (relativeMarkdown.startsWith('docs/architecture/')
      && /^## (?:下一步|实施计划|本轮(?:完成|进度))/mu.test(markdown)) {
    errors.push(`${relativeMarkdown}: 当前架构不得包含阶段计划或本轮日志标题`);
  }

  const isHistorical = relativeMarkdown.startsWith('docs/maintenance/')
    || relativeMarkdown.startsWith('docs/archive/');
  if (!isHistorical) {
    for (const stale of ['1.4.4@9433094-12', '31 名角色', '31 个角色', '31 角色']) {
      if (markdown.includes(stale)) errors.push(`${relativeMarkdown}: 当前文档包含已退役快照文本 ${stale}`);
    }
  }

  if (relativeMarkdown === 'docs/evidence/current-snapshot.md'
      && !rawMarkdown.startsWith('<!-- GENERATED by scripts/render-current-evidence.mjs. DO NOT EDIT. -->\n')) {
    errors.push(`${relativeMarkdown}: 缺少生成文件标记`);
  }
  for (const match of markdown.matchAll(markdownLink)) {
    const target = linkTarget(match[1]);
    if (!target || isExternalOrAnchor(target)) continue;
    checkedLinks += 1;
    const pathOnly = target.split(/[?#]/u, 1)[0];
    if (!pathOnly) continue;
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathOnly);
    } catch {
      errors.push(`${relativeMarkdown}: 无法解码链接 ${target}`);
      continue;
    }
    const resolvedPath = decodedPath.startsWith('/')
      ? path.resolve(repositoryRoot, `.${decodedPath}`)
      : path.resolve(path.dirname(markdownFile), decodedPath);
    const insideRepository = resolvedPath === repositoryRoot || resolvedPath.startsWith(`${repositoryRoot}${path.sep}`);
    if (!insideRepository) {
      errors.push(`${relativeMarkdown}: 链接越出仓库 ${target}`);
      continue;
    }
    if (!(await exists(resolvedPath))) {
      errors.push(`${relativeMarkdown}: 链接不存在 ${target}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `DOCS_CHECK_ERROR ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`DOCS_CHECK_OK files=${markdownFiles.length} links=${checkedLinks}`);
}
