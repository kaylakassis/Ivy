// Spanish strings. Missing keys fall back to English at runtime
// (see i18n.js), so it's safe to ship a partial translation —
// untranslated surfaces just stay in English until translated.
export default {
  'common.save':         'Guardar',
  'common.cancel':       'Cancelar',
  'common.delete':       'Eliminar',
  'common.confirm':      'Confirmar',
  'common.close':        'Cerrar',
  'common.loading':      'Cargando…',
  'common.try_again':    'Reintentar',
  'common.back':         'Atrás',
  'common.next':         'Siguiente',
  'common.search':       'Buscar',
  'common.load_more':    'Cargar más',

  'nav.home':         'Inicio',
  'nav.messages':     'Mensajes',
  'nav.bookings':     'Reservas',
  'nav.payments':     'Pagos',
  'nav.documents':    'Documentos',
  'nav.discover':     'Descubrir',
  'nav.account':      'Cuenta',
  'nav.profile':      'Tu perfil',
  'nav.email_prefs':  'Preferencias de email',
  'nav.sign_out':     'Cerrar sesión',

  'auth.signin.title':       'Iniciar sesión',
  'auth.signin.email':       'Correo electrónico',
  'auth.signin.password':    'Contraseña',
  'auth.signin.submit':      'Iniciar sesión',
  'auth.signin.forgot':      '¿Olvidaste tu contraseña?',
  'auth.signup.title':       'Crea tu cuenta',
  'auth.signup.submit':      'Crear cuenta',
  'auth.signup.have_account': '¿Ya tienes una cuenta?',

  'billing.trial_ending_today':     'Tu prueba gratuita termina hoy.',
  'billing.trial_ending_tomorrow':  'Tu prueba gratuita termina mañana.',
  'billing.trial_ending_days':      'Tu prueba gratuita termina en {n} días.',
  'billing.subscribe':              'Suscribirse',
  'billing.update_card':            'Actualizar tarjeta',
  'billing.card_declined':          'Tarjeta rechazada.',
  'billing.account_suspended':      'Cuenta suspendida.',

  'inbox.unread_one':       '1 sin leer',
  'inbox.unread_other':     '{n} sin leer',
  'inbox.no_threads':       'No hay conversaciones todavía.',
  'inbox.new_message':      'Mensaje nuevo',

  'error.network':       'Error de red — verifica tu conexión e intenta de nuevo.',
  'error.unauthorized':  'Necesitas iniciar sesión.',
  'error.server':        'Algo salió mal. Recibimos una notificación.',
};
