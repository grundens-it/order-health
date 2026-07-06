// Order-number search box. Filters rows whose nav_order_no OR shopify_order_name
// contains the query (case-insensitive substring; the App trims and matches).
// Labelled and keyboard-usable, consistent with the other lifecycle controls.
export function OrderSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}): JSX.Element {
  return (
    <label className="searchctl">
      <span className="selctl-label">Search</span>
      <input
        type="search"
        aria-label="Search by order number"
        placeholder="Order number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
