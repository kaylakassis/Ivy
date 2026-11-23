// Features that were taken out of Ivy.
//
// When a feature is retired its screens go away, but two things stay:
//   - what people already put in (nothing is deleted; it is still in the
//     database, in the data download, and in the tax summary where it
//     belongs), and
//   - its addresses, answering plainly. An iPhone app from before the
//     removal still has the old screens until it is updated; it can keep
//     READING what is there, and any attempt to add or change gets one
//     plain sentence instead of an error.
export const RETIRED_MESSAGES = {
  campaigns: 'Email campaigns are no longer part of Ivy. Nothing was sent.',
  expenses: 'Expense tracking is no longer part of Ivy. What you logged is safe: it is still in your tax summary and your data download.',
  time: 'Time tracking is no longer part of Ivy. What you logged is safe: it is still in your data download.',
};

// For a retired feature's endpoint: reads go on as before, anything else is
// answered here. Returns true when it sent the response.
export function retiredWrite(req, res, what) {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  res.setHeader?.('Cache-Control', 'no-store');
  res.status(410).json({ error: RETIRED_MESSAGES[what] || 'This is no longer part of Ivy.', code: 'feature-retired' });
  return true;
}
