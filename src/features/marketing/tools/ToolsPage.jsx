// /tools and /tools/:slug, the free tools. One route chunk for the hub and
// the three tools (App.jsx lazy-loads it; scripts/prerender.mjs saves each
// page as static HTML). An unknown slug goes back to the hub.
import React from 'react';
import { Navigate, useParams } from 'react-router-dom';
import ToolsHub from './ToolsHub.jsx';
import CancellationPolicyTool from './CancellationPolicyTool.jsx';
import DepositCalculatorTool from './DepositCalculatorTool.jsx';
import IntakeTemplatesTool from './IntakeTemplatesTool.jsx';

const PAGES = {
  'cancellation-policy-generator': CancellationPolicyTool,
  'deposit-calculator': DepositCalculatorTool,
  'intake-form-templates': IntakeTemplatesTool,
};

export default function ToolsPage() {
  const { slug } = useParams();
  if (!slug) return <ToolsHub/>;
  const Page = PAGES[slug];
  if (!Page) return <Navigate to="/tools" replace/>;
  return <Page/>;
}
