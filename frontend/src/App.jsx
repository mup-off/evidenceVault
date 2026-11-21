import { Route, Routes } from 'react-router';

import { RequireAuth, RequireRole } from './auth/guards.jsx';
import Layout from './components/Layout.jsx';
import { NotFound } from './components/ui.jsx';
import CaseDetail from './pages/CaseDetail.jsx';
import CaseList from './pages/CaseList.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Planned from './pages/Planned.jsx';
import SignIn from './pages/SignIn.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />

      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="cases" element={<CaseList />} />
          <Route path="cases/:id" element={<CaseDetail />} />

          {/* Phase 5 screens */}
          <Route path="evidence" element={<Planned title="Evidence" />} />
          <Route path="evidence/:id" element={<Planned title="Evidence detail" />} />
          <Route element={<RequireRole roles={['administrator', 'auditor']} />}>
            <Route path="audit" element={<Planned title="Audit log" />} />
          </Route>
          <Route element={<RequireRole roles={['administrator']} />}>
            <Route path="users" element={<Planned title="User management" />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
