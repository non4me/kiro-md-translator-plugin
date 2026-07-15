/** Extract the LAST ```rmt-edit fence body (req 7 dedicated edit channel). An
 *  ordinary code fence never matches, so a spec explanation that quotes code does
 *  not light up Apply Changes. */
export function extractEdit(reply: string): string | undefined {
  const re = /```rmt-edit[^\n]*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  let last: string | undefined
  while ((m = re.exec(reply)) !== null) last = m[1].replace(/\n$/, '')
  return last === undefined ? undefined : last.trim()
}
