/** 중립 마크업 v1: 제목, 목록, 굵게, 줄바꿈만 지원한다. 나머지는 데이터다. */
const prefix = '[brain-markup-v1]\n';
const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function telegramMarkup(text: string): { plain: string; html?: string } | null {
  if (!text.startsWith(prefix)) return null;
  const body = text.slice(prefix.length);
  const plain = body.split('\n').map(line => line.replace(/^#{1,2} /, '').replace(/^- /, '• ').replaceAll('**', '')).join('\n');
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
    // 보수적으로 escape 뒤 길이까지 제한한다. 초과하면 완전한 평문으로 보낸다.
    return html.length <= 4096 ? { plain, html } : { plain };
  } catch { return { plain }; }
}
