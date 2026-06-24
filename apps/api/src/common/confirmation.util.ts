/** Patient SMS bodies that count as appointment confirmation (demo heuristic). */
export function isConfirmationBody(body: string): boolean {
  return /^yes\b/i.test(body.trim());
}
