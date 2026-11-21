import { Link } from 'react-router';

import { PageHeader } from '../components/ui.jsx';

/** Placeholder for screens scheduled in Phase 5. The API behind them already works. */
export default function Planned({ title }) {
  return (
    <>
      <PageHeader kicker="Phase 5 · Not built yet" title={title} />
      <div className="planned">
        <p>
          This screen is part of Phase 5 (evidence screens). Its API is already in place; see{' '}
          <code>backend/README.md</code> and <code>backend/requests.http</code>.
        </p>
        <Link className="btn" to="/cases">
          Go to cases
        </Link>
      </div>
    </>
  );
}
