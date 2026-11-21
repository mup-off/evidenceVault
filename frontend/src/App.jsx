import { Route, Routes } from 'react-router';

import { RequireAuth, RequireRole } from './auth/guards.jsx';
import Layout from './components/Layout.jsx';
import { NotFound } from './components/ui.jsx';
import Alerts from './pages/Alerts.jsx';
import AuditLog from './pages/AuditLog.jsx';
import CaseDetail from './pages/CaseDetail.jsx';
import CaseList from './pages/CaseList.jsx';
import Dashboard from './pages/Dashboard.jsx';
import EvidenceDetail from './pages/EvidenceDetail.jsx';
import EvidenceList from './pages/EvidenceList.jsx';
import RegisterEvidence from './pages/RegisterEvidence.jsx';
import Report from './pages/Report.jsx';
import SignIn from './pages/SignIn.jsx';
import Users from './pages/Users.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />

      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="cases" element={<CaseList />} />
          <Route path="cases/:id" element={<CaseDetail />} />

          <Route path="evidence" element={<EvidenceList />} />
          <Route element={<RequireRole roles={['administrator', 'investigator']} />}>
            <Route path="evidence/new" element={<RegisterEvidence />} />
          </Route>
          <Route path="evidence/:id" element={<EvidenceDetail />} />
          <Route path="evidence/:id/report" element={<Report />} />

          <Route element={<RequireRole roles={['administrator', 'auditor']} />}>
            <Route path="audit" element={<AuditLog />} />
            <Route path="alerts" element={<Alerts />} />
          </Route>
          <Route element={<RequireRole roles={['administrator']} />}>
            <Route path="users" element={<Users />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
