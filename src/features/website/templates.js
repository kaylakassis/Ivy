// Visual templates — each defines the base palette, typography, and radii
// that the rendered site will inherit. Templates are applied by scoping a
// CSS variable block on the outer wrapper.

export const TEMPLATES = {
  clean: {
    id: 'clean',
    name: 'Clean & Modern',
    desc: 'White space, minimal layout — lets your work speak.',
    vars: {
      '--site-bg':        '#FFFFFF',
      '--site-fg':        '#141414',
      '--site-fg-2':      '#4A4A46',
      '--site-muted':     '#85827B',
      '--site-accent':    '#2E3168',
      '--site-accent-ink':'#FFFFFF',
      '--site-surface':   '#FAF8F3',
      '--site-border':    '#E8E4DC',
      '--site-radius':    '12px',
      '--site-font-display': "'Fraunces', Georgia, serif",
      '--site-font-body':    "'Inter', -apple-system, sans-serif",
    },
  },
  warm: {
    id: 'warm',
    name: 'Warm & Personal',
    desc: 'Earthy tones, personal feel — great for coaches & wellness.',
    vars: {
      '--site-bg':        '#FBF7F0',
      '--site-fg':        '#2A1F14',
      '--site-fg-2':      '#5A4A3A',
      '--site-muted':     '#8C7560',
      '--site-accent':    '#B05F2C',
      '--site-accent-ink':'#FFFFFF',
      '--site-surface':   '#F5EDDE',
      '--site-border':    '#E5DDCC',
      '--site-radius':    '16px',
      '--site-font-display': "'Fraunces', Georgia, serif",
      '--site-font-body':    "'Inter', -apple-system, sans-serif",
    },
  },
  bold: {
    id: 'bold',
    name: 'Bold & Electric',
    desc: 'Dark background, bright accents — high-impact and memorable.',
    vars: {
      '--site-bg':        '#0D0E0C',
      '--site-fg':        '#F3F3EE',
      '--site-fg-2':      '#C9CAC3',
      '--site-muted':     '#8A8D85',
      '--site-accent':    '#CFFF50',
      '--site-accent-ink':'#0B0C08',
      '--site-surface':   '#1A1C1A',
      '--site-border':    '#262A2D',
      '--site-radius':    '10px',
      '--site-font-display': "'Space Grotesk', 'Inter', sans-serif",
      '--site-font-body':    "'Inter', sans-serif",
    },
  },
};

export const TEMPLATE_LIST = Object.values(TEMPLATES);
