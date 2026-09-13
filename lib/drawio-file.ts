// .drawio (mxfile XML) 文件助手:不解析 XML 语义——内容原样交给 drawio
// 引擎;这里只负责"有效 vs 损坏"判定,并提供空白画布模板。

export const EMPTY_DRAWIO_XML =
  '<mxfile host="pi-web" version="31.4.5">' +
  '<diagram id="page-1" name="Page-1">' +
  '<mxGraphModel dx="1422" dy="798" grid="1" gridSize="10" guides="1" tooltips="1" ' +
  'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" ' +
  'math="0" shadow="0"><root><mxCell id="0" /><mxCell id="1" parent="0" /></root>' +
  '</mxGraphModel></diagram></mxfile>';

// 全压缩体(deflate+base64,完全无 '<')有意拒绝:drawio 首次保存时会自行
// 重序列化,对我们无法识别的内容走损坏回退(错误提示 + 以文本打开)更安全。
export function isValidDrawioXml(text: string): boolean {
  if (typeof text !== "string") return false;
  return /<mxfile[\s>]/i.test(text) || /<mxGraphModel[\s>]/i.test(text);
}