/** List changed cells of a role → capability matrix as "role.capability: from → to" (for audit metadata). */
export function diffMatrix(before: Record<string, Record<string, unknown>>, after: Record<string, Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const role of Object.keys(after)) {
    for (const cap of Object.keys(after[role])) {
      const a = before[role]?.[cap];
      const b = after[role][cap];
      if (a !== b) out.push(`${role}.${cap}: ${String(a)} → ${String(b)}`);
    }
  }
  return out;
}
