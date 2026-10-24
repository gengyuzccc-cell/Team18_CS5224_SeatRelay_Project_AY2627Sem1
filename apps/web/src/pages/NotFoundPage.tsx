import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { useDocumentTitle } from '../util/useDocumentTitle';

export function NotFoundPage() {
  useDocumentTitle('Page not found');
  return (
    <section className="card panel-center">
      <Icon name="seat" className="panel-icon" />
      <h1>Page not found</h1>
      <p className="muted">That address does not match any SeatRelay page.</p>
      <Link to="/" className="btn btn-primary">
        Home
      </Link>
    </section>
  );
}
