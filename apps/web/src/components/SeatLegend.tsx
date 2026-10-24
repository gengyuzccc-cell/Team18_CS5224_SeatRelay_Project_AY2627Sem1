/** Key for the capacity cells' seat bars (decorative: the numbers are in the cells). */
export function SeatLegend() {
  return (
    <p className="seat-legend small" aria-hidden="true">
      <i className="sw sw-confirmed" />
      confirmed <i className="sw sw-held" />
      held <i className="sw sw-free" />
      free
    </p>
  );
}
