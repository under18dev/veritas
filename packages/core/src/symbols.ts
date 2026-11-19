/**
 * Symbol IDs shared by every module: `<posix path relative to the project root>#<exported name>`,
 * e.g. `src/pricing.ts#discountAmount`. Methods use `Class.method`.
 */
export function symbolId(relativeFile: string, name: string): string {
  return `${relativeFile.split('\\').join('/')}#${name}`;
}

export function parseSymbolId(id: string): { file: string; name: string } {
  const index = id.lastIndexOf('#');
  if (index <= 0 || index === id.length - 1) throw new Error(`invalid symbol id: ${id}`);
  return { file: id.slice(0, index), name: id.slice(index + 1) };
}
