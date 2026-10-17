import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <section className="card panel-center">
      <h1>Page not found</h1>
      <p className="muted">That address does not match any SeatRelay page.</p>
      <Link to="/" className="btn btn-primary">
        Home
      </Link>
    </section>
  );
}
