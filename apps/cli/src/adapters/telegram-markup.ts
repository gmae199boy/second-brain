/** 중립 마크업 v1: 제목, 목록, 굵게, 줄바꿈만 지원한다. 나머지는 데이터다. */
const prefix = '[brain-markup-v1]\n';
const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const clip = (text: string): string => {
  if (text.length <= 4096) return text;
  let cut = text.slice(0, 4095);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + '…';
};
export function telegramMarkup(text: string): { plain: string; html?: string } | null {
  if (!text.startsWith(prefix)) return null;
  const body = text.slice(prefix.length);
  const plain = clip(body.split('\n').map(line => line.replace(/^#{1,2} /, '').replace(/^- /, '• ').replaceAll('**', '')).join('\n'));
  try {
    // 잘못된 Unicode는 HTML escape 대신 평문으로 내린다.
    if (!body.isWellFormed()) return { plain: plain.toWellFormed() };
    const html = body.split('\n').map(line => {
      const heading = /^#{1,2} /.test(line);
      const source = line.replace(/^#{1,2} /, '').replace(/^- /, '• ');
      const chunks = source.split('**');
      if (chunks.length % 2 === 0) throw new Error('unbalanced emphasis');
      const inner = chunks.map((chunk, index) => index % 2 ? `<b>${escape(chunk)}</b>` : escape(chunk)).join('');
      return heading ? `<b>${inner}</b>` : inner;
    }).join('\n');
    // 보수적으로 escape 뒤 길이까지 제한한다. 평문은 UTF-16 경계를 보존한다.
    return html.length <= 4096 ? { plain, html } : { plain };
  } catch { return { plain }; }
}
