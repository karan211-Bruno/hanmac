import { escapeHtml } from '../../../shared/hwpxHtml'

export function titleFromName(name: string): string {
  return name.replace(/\.[^./\\]+$/, '').trim() || '제목 없음'
}

export function siblingPath(path: string | null, extension: string): string | null {
  if (!path) return null
  return path.replace(/\.[^./\\]+$/, '') + '.' + extension
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '알 수 없는 오류가 발생했습니다.'
}

/** 내보내기용 독립 HTML 문서. */
export function standaloneHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --paper: #fffdf8;
    --ink: #1f1d1a;
    --line: #cfc8ba;
    --accent: #a8432f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #ece9e1;
    color: var(--ink);
    font-family: "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", sans-serif;
    font-size: 15px;
    line-height: 1.85;
    word-break: keep-all;
    overflow-wrap: break-word;
  }
  .paper {
    width: 794px;
    min-height: 1123px;
    margin: 40px auto;
    padding: 72px 82px 92px;
    background: var(--paper);
    box-shadow: 0 18px 40px rgba(40, 35, 28, .12);
    border: 1px solid rgba(80, 70, 55, .1);
  }
  h1 { font-size: 26px; line-height: 1.35; margin: 1.1em 0 .5em; letter-spacing: -.02em; }
  h2 { font-size: 22px; line-height: 1.4; margin: 1.1em 0 .5em; letter-spacing: -.01em; }
  h3 { font-size: 19px; line-height: 1.45; margin: 1em 0 .4em; }
  h4, h5, h6 { font-size: 16px; margin: 1em 0 .4em; }
  p { margin: 0 0 .55em; }
  ul, ol { padding-left: 1.4em; margin: .4em 0 .7em; }
  li p { margin: 0; }
  table { border-collapse: collapse; width: 100%; margin: .9em 0; table-layout: fixed; }
  td, th { border: 1px solid var(--line); padding: 8px 10px; vertical-align: top; }
  th { background: #f4f0e6; }
  blockquote { border-left: 3px solid var(--accent); margin: 1em 0; padding: .1em 0 .1em 1em; color: #4b463e; }
  img { max-width: 100%; height: auto; }
  mark { background: #fff1a8; padding: 0 .1em; }
  hr { border: none; border-top: 1px solid var(--line); margin: 1.6em 0; }
  a { color: #2f6b57; text-decoration: underline; text-underline-offset: 2px; }
  code { font-family: "SFMono-Regular", Menlo, monospace; font-size: .92em; background: #f3efe6; padding: .1em .3em; border-radius: 3px; }
  .page-break { page-break-after: always; height: 0; }
  .tableWrapper { overflow-x: auto; }
  @media print {
    body { background: #fff; font-size: 11pt; }
    .paper { width: auto; min-height: 0; margin: 0; padding: 0; border: none; box-shadow: none; background: #fff; }
    @page { size: A4; margin: 20mm 20mm 22mm; }
  }
</style>
</head>
<body>
<div class="paper">${body}</div>
</body>
</html>`
}
