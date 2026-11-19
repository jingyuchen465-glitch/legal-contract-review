export const uploadAccept = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.odt,.ods,.odp';
export const uploadHint = 'PDF、Word、Excel、CSV、PPT、ODT/ODS/ODP（每份 ≤ 50MB）';
export function uploadProblem(files) {
  for (const file of files) {
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!uploadAccept.split(',').includes(ext)) return `${file.name}：暂不支持该格式，请上传 PDF、Word、Excel、CSV 或 PPT 文件`;
    if (!file.size || file.size > 50 * 1024 * 1024) return `${file.name}：请选择不超过 50MB 的非空文件`;
  }
  return '';
}
