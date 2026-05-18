// English strings. The canonical source — every other locale
// inherits the schema from this file. Keys are dotted by surface:
//   marketing.*  — public marketing site
//   auth.*       — sign-in / sign-up flows
//   nav.*        — top + side navigation
//   common.*     — shared UI bits (Save, Cancel, etc.)
//   billing.*    — subscription / past_due / suspended UI
//   inbox.*      — messages UI
//
// Add keys here first; translations go in es.js / fr.js / etc.
//
// Plural keys: append _one / _other instead of writing if/else in
// components. e.g.
//   'inbox.unread_one':   '1 unread',
//   'inbox.unread_other': '{n} unread',
//
// Use t('inbox.unread', { n: 5 }) and the i18n module picks the
// right key automatically.

export default {
  // Common UI verbs / nouns
  'common.save':         'Save',
  'common.cancel':       'Cancel',
  'common.delete':       'Delete',
  'common.confirm':      'Confirm',
  'common.close':        'Close',
  'common.loading':      'Loading…',
  'common.try_again':    'Try again',
  'common.back':         'Back',
  'common.next':         'Next',
  'common.search':       'Search',
  'common.load_more':    'Load more',

  // Navigation
  'nav.home':         'Home',
  'nav.messages':     'Messages',
  'nav.bookings':     'Bookings',
  'nav.payments':     'Payments',
  'nav.documents':    'Documents',
  'nav.discover':     'Discover',
  'nav.account':      'Account',
  'nav.profile':      'Your profile',
  'nav.email_prefs':  'Email preferences',
  'nav.sign_out':     'Sign out',

  // Auth flows
  'auth.signin.title':       'Sign in',
  'auth.signin.email':       'Email',
  'auth.signin.password':    'Password',
  'auth.signin.submit':      'Sign in',
  'auth.signin.forgot':      'Forgot password?',
  'auth.signup.title':       'Create your account',
  'auth.signup.submit':      'Create account',
  'auth.signup.have_account': 'Already have an account?',

  // Billing / subscription
  'billing.trial_ending_today':     'Your free trial ends today.',
  'billing.trial_ending_tomorrow':  'Your free trial ends tomorrow.',
  'billing.trial_ending_days':      'Your free trial ends in {n} days.',
  'billing.subscribe':              'Subscribe',
  'billing.update_card':            'Update card',
  'billing.card_declined':          'Card declined.',
  'billing.account_suspended':      'Account suspended.',

  // Inbox
  'inbox.unread_one':       '1 unread',
  'inbox.unread_other':     '{n} unread',
  'inbox.no_threads':       'No conversations yet.',
  'inbox.new_message':      'New message',

  // Errors
  'error.network':       'Network error — check your connection and try again.',
  'error.unauthorized':  'You need to sign in.',
  'error.server':        'Something went wrong on our end. We were notified.',
};
