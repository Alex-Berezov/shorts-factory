/** What a section shows instead of its data - never a zero. */
export function NoData({ label }: { label: string }) {
  return <p className="text-sm text-muted-foreground">{label}</p>;
}
