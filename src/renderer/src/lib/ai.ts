export type AiAction =
  | 'summarize'
  | 'refine'
  | 'formal'
  | 'concise'
  | 'translate-en'
  | 'translate-ko'
  | 'continue'
  | 'custom'

export function actionInstruction(action: AiAction): string {
  switch (action) {
    case 'summarize':
      return '다음 글의 핵심 내용을 5개 이내의 문장으로 요약해 주세요. 중요한 수치와 고유명사는 유지하세요.'
    case 'refine':
      return '다음 글의 맞춤법, 띄어쓰기, 문장 흐름을 자연스럽게 다듬어 주세요. 원문의 의미와 정보는 그대로 유지하세요.'
    case 'formal':
      return '다음 글을 격식 있고 전문적인 업무 문체로 고쳐 주세요. 지나친 수식어는 줄이고 명확하게 쓰세요.'
    case 'concise':
      return '다음 글의 의미를 유지하면서 30% 정도 더 간결하게 줄여 주세요. 중복되는 표현을 정리하세요.'
    case 'translate-en':
      return '다음 한국어 글을 자연스럽고 정확한 영어로 번역해 주세요. 번역문만 출력하세요.'
    case 'translate-ko':
      return '다음 영어 글을 자연스럽고 정확한 한국어로 번역해 주세요. 번역문만 출력하세요.'
    case 'continue':
      return '다음 글의 흐름과 문체를 이어서 한두 문단을 작성해 주세요. 기존 내용과 자연스럽게 연결되도록 하세요.'
    case 'custom':
      return ''
  }
}

/** 너무 긴 문서를 AI에 보낼 때 앞부분을 잘라낸다. */
export function truncateContext(text: string, max = 14_000): string {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max)}\n\n[이하 생략]`
}
