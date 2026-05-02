import React from 'react';
import { Routes, Route } from 'react-router-dom';
import AppShell from './components/layout/AppShell.jsx';
import RequireAuth from './features/auth/RequireAuth.jsx';
import AuthPage from './features/auth/AuthPage.jsx';
import ForgotPasswordPage from './features/auth/ForgotPasswordPage.jsx';
import ResetPasswordPage from './features/auth/ResetPasswordPage.jsx';
import VerifyEmailPage from './features/auth/VerifyEmailPage.jsx';
import Dashboard from './features/dashboard/Dashboard.jsx';
import Clients from './features/clients/Clients.jsx';
import Calendar from './features/calendar/Calendar.jsx';
import Finance from './features/finance/Finance.jsx';
import Goals from './features/goals/Goals.jsx';
import Rewards from './features/rewards/Rewards.jsx';
import Messages from './features/messages/Messages.jsx';
import Documents from './features/documents/Documents.jsx';
import SignPage from './features/documents/SignPage.jsx';
import PublicInvoice from './features/finance/PublicInvoice.jsx';
import Website from './features/website/Website.jsx';
import IvyPro from './features/ivy/IvyPro.jsx';
import AccountPage from './features/account/AccountPage.jsx';
import ClientShell from './features/client/ClientShell.jsx';
import ClientHome from './features/client/ClientHome.jsx';
import ClientMessages from './features/client/ClientMessages.jsx';
import ClientStub from './features/client/ClientStub.jsx';
import RoleRouter from './features/auth/RoleRouter.jsx';
import PublicBooking from './features/calendar/PublicBooking.jsx';
import PublicSite from './features/website/PublicSite.jsx';
import PrivacyPage from './features/legal/PrivacyPage.jsx';
import TermsPage from './features/legal/TermsPage.jsx';

export default function App() {
  return (
    <Routes>
      {/* Auth */}
      <Route path="/signin"          element={<AuthPage mode="signin" />} />
      <Route path="/signup"          element={<AuthPage mode="signup" />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password"  element={<ResetPasswordPage />} />
      <Route path="/verify-email"    element={<VerifyEmailPage />} />

      {/* Public */}
      <Route path="/book/:slug"   element={<PublicBooking />} />
      <Route path="/site/:handle" element={<PublicSite />} />
      <Route path="/sign/:token"     element={<SignPage />} />
      <Route path="/invoice/:token"  element={<PublicInvoice />} />

      {/* Legal (public, no auth) */}
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms"   element={<TermsPage />} />

      {/* Business app shell (auth-gated). RoleRouter sends client-only
          users to /me before the shell renders. */}
      <Route element={<RequireAuth><RoleRouter><AppShell /></RoleRouter></RequireAuth>}>
        <Route index              element={<Dashboard />} />
        <Route path="/clients"    element={<Clients />} />
        <Route path="/calendar"   element={<Calendar />} />
        <Route path="/finance"    element={<Finance />} />
        <Route path="/goals"      element={<Goals />} />
        <Route path="/rewards"    element={<Rewards />} />
        <Route path="/messages"   element={<Messages />} />
        <Route path="/documents"  element={<Documents />} />
        <Route path="/website"    element={<Website />} />
        <Route path="/ivy"        element={<IvyPro />} />
        <Route path="/account"    element={<AccountPage />} />
      </Route>

      {/* Client portal shell (auth-gated). Anyone can navigate here directly;
          the data they see is filtered by their email / user_id. */}
      <Route element={<RequireAuth><ClientShell /></RequireAuth>}>
        <Route path="/me"           element={<ClientHome />} />
        <Route path="/me/messages"  element={<ClientMessages />} />
        <Route path="/me/bookings"  element={<ClientStub icon="Calendar" title="Bookings — coming soon"
          hint="Your appointments across all THRYVE businesses will land here."/>} />
        <Route path="/me/invoices"  element={<ClientStub icon="Dollar" title="Payments — coming soon"
          hint="Pending and paid invoices from every business you book with."/>} />
        <Route path="/me/documents" element={<ClientStub icon="Doc" title="Documents — coming soon"
          hint="Waivers, agreements, and intake forms awaiting your signature."/>} />
      </Route>
    </Routes>
  );
}
