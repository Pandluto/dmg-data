import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.join(repositoryRoot, 'docs');
const requiredEntryPoints = [
  'README.md',
  'docs/README.md',
  'docs/architecture/README.md',
  'docs/testing/README.md',
  'docs/research/README.md',
  'docs/guides/development.md',
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
for (const entry of topLevelEntries) {
  if (entry.isFile() && /^\d{2}-.*\.md$/u.test(entry.name)) {
    errors.push(`编号历史文档仍在 docs 顶层: docs/${entry.name}`);
  }
}

const markdownFiles = [
  path.join(repositoryRoot, 'README.md'),
  path.join(repositoryRoot, 'NOTICE.md'),
  ...(await collectCurrentMarkdown(docsRoot))
].filter((filePath, index, files) => files.indexOf(filePath) === index && filePath && path.extname(filePath) === '.md');

let checkedLinks = 0;
const markdownLink = /!?\[[^\]\n]*\]\(([^)\n]+)\)/gu;
for (const markdownFile of markdownFiles) {
  if (!(await exists(markdownFile))) continue;
  const markdown = removeFencedCode(await readFile(markdownFile, 'utf8'));
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
      errors.push(`${path.relative(repositoryRoot, markdownFile)}: 无法解码链接 ${target}`);
      continue;
    }
    const resolvedPath = decodedPath.startsWith('/')
      ? path.resolve(repositoryRoot, `.${decodedPath}`)
      : path.resolve(path.dirname(markdownFile), decodedPath);
    const insideRepository = resolvedPath === repositoryRoot || resolvedPath.startsWith(`${repositoryRoot}${path.sep}`);
    if (!insideRepository) {
      errors.push(`${path.relative(repositoryRoot, markdownFile)}: 链接越出仓库 ${target}`);
      continue;
    }
    if (!(await exists(resolvedPath))) {
      errors.push(`${path.relative(repositoryRoot, markdownFile)}: 链接不存在 ${target}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `DOCS_CHECK_ERROR ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`DOCS_CHECK_OK files=${markdownFiles.length} links=${checkedLinks}`);
}
