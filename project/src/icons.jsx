// Minimal icon set - stroke-based, 20px default
const Icon = ({ d, size = 20, stroke = 'currentColor', fill = 'none', sw = 1.6, children, ...rest }) => (
  <svg
    width={size} height={size} viewBox="0 0 24 24"
    fill={fill} stroke={stroke} strokeWidth={sw}
    strokeLinecap="round" strokeLinejoin="round"
    {...rest}
  >
    {d ? <path d={d} /> : children}
  </svg>
);

const Icons = {
  Home:     (p) => <Icon {...p}><path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></Icon>,
  Users:    (p) => <Icon {...p}><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><circle cx="17" cy="7" r="2.5"/><path d="M20 15c1.5.5 2.5 2 2.7 4"/></Icon>,
  Calendar: (p) => <Icon {...p}><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17"/><path d="M8 3.5v3M16 3.5v3"/></Icon>,
  Dollar:   (p) => <Icon {...p}><path d="M12 3v18M16 7.5c-.8-1.3-2.3-2-4-2-2.5 0-4 1.4-4 3 0 4 8 2.5 8 6.5 0 1.8-1.8 3.2-4 3.2-2 0-3.6-.9-4.3-2.3"/></Icon>,
  Spark:    (p) => <Icon {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 3.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9L16.5 6l1.9-.6L19 3.5z"/></Icon>,
  Chat:     (p) => <Icon {...p}><path d="M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v8A2.5 2.5 0 0117.5 17H11l-4 3.5v-3.5H6.5A2.5 2.5 0 014 14.5v-8z"/></Icon>,
  Doc:      (p) => <Icon {...p}><path d="M6 3h8l4 4v13a1.5 1.5 0 01-1.5 1.5h-10.5A1.5 1.5 0 014.5 20V4.5A1.5 1.5 0 016 3z"/><path d="M14 3v4.5h4"/><path d="M8 12h8M8 15.5h8M8 19h5"/></Icon>,
  Globe:    (p) => <Icon {...p}><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.7 3.8 5.8 3.8 8.5S14.5 18.3 12 21c-2.5-2.7-3.8-5.8-3.8-8.5S9.5 6.2 12 3.5z"/></Icon>,
  Search:   (p) => <Icon {...p}><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></Icon>,
  Bell:     (p) => <Icon {...p}><path d="M5.5 17.5L6 13c0-3 2.5-5.5 6-5.5s6 2.5 6 5.5l.5 4.5H5.5z"/><path d="M10 20.5a2 2 0 004 0"/><path d="M12 4.5v3"/></Icon>,
  Settings: (p) => <Icon {...p}><circle cx="12" cy="12" r="2.8"/><path d="M19.5 12l1.8-1.3-1-2.7-2.2.4-1.5-1.5.4-2.2-2.7-1L13 6.5h-2L9.7 4.7l-2.7 1 .4 2.2-1.5 1.5-2.2-.4-1 2.7L4.5 13v2l-1.8 1.3 1 2.7 2.2-.4 1.5 1.5-.4 2.2 2.7 1L11 21.5h2l1.3-1.8 2.7 1 1.5-1.5-.4-2.2 2.2.4 1-2.7-1.8-1.3v-2z"/></Icon>,
  Plus:     (p) => <Icon {...p}><path d="M12 5v14M5 12h14"/></Icon>,
  Arrow:    (p) => <Icon {...p}><path d="M5 12h14M13 6l6 6-6 6"/></Icon>,
  ArrowUp:  (p) => <Icon {...p}><path d="M12 19V5M6 11l6-6 6 6"/></Icon>,
  ArrowDown:(p) => <Icon {...p}><path d="M12 5v14M6 13l6 6 6-6"/></Icon>,
  Check:    (p) => <Icon {...p}><path d="M4 12l5 5L20 6"/></Icon>,
  X:        (p) => <Icon {...p}><path d="M5 5l14 14M19 5L5 19"/></Icon>,
  More:     (p) => <Icon {...p}><circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none"/></Icon>,
  Phone:    (p) => <Icon {...p}><path d="M4.5 5.5c0-.8.7-1.5 1.5-1.5h2.4c.6 0 1.1.4 1.3 1l1.1 3.2c.1.5 0 1-.4 1.3l-1.7 1.3c1.2 2.5 3.1 4.4 5.6 5.6l1.3-1.7c.3-.4.9-.5 1.3-.4l3.2 1.1c.6.2 1 .7 1 1.3V18c0 .8-.7 1.5-1.5 1.5C10.9 19.5 4.5 13.1 4.5 5.5z"/></Icon>,
  Clock:    (p) => <Icon {...p}><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></Icon>,
  Trending: (p) => <Icon {...p}><path d="M3.5 17L10 10.5l3.5 3.5L20.5 7"/><path d="M15 7h5.5v5.5"/></Icon>,
  Mail:     (p) => <Icon {...p}><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M4 7l8 6 8-6"/></Icon>,
  Menu:     (p) => <Icon {...p}><path d="M4 7h16M4 12h16M4 17h10"/></Icon>,
  Filter:   (p) => <Icon {...p}><path d="M4 5h16l-6 8v5l-4 2v-7L4 5z"/></Icon>,
  Gift:     (p) => <Icon {...p}><rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5 12v8.5h14V12"/><path d="M12 8v12.5"/><path d="M12 8c-2-3.5-6-3-6-1 0 1.5 2 1 6 1zM12 8c2-3.5 6-3 6-1 0 1.5-2 1-6 1z"/></Icon>,
  Edit:     (p) => <Icon {...p}><path d="M4 20l4-1 10-10-3-3L5 16l-1 4z"/><path d="M13.5 6.5l3 3"/></Icon>,
  Paperclip:(p) => <Icon {...p}><path d="M20.5 11.5L12 20a5 5 0 01-7-7l8.5-8.5a3.5 3.5 0 015 5L10 18a2 2 0 01-3-3l7.5-7.5"/></Icon>,
  Camera:   (p) => <Icon {...p}><path d="M4 8.5A2 2 0 016 6.5h2l1.5-2h5L16 6.5h2a2 2 0 012 2V18a2 2 0 01-2 2H6a2 2 0 01-2-2V8.5z"/><circle cx="12" cy="13" r="3.5"/></Icon>,
  Image:    (p) => <Icon {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4 4"/></Icon>,
  FileIcon: (p) => <Icon {...p}><path d="M6 3h8l4 4v13a1.5 1.5 0 01-1.5 1.5h-10.5A1.5 1.5 0 014.5 20V4.5A1.5 1.5 0 016 3z"/><path d="M14 3v4.5h4"/></Icon>,
  Bank:     (p) => <Icon {...p}><path d="M3 10l9-6 9 6"/><path d="M5 10v8M10 10v8M14 10v8M19 10v8"/><path d="M3 20h18"/></Icon>,
  Lock:     (p) => <Icon {...p}><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></Icon>,
  Receipt:  (p) => <Icon {...p}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6M9 16h4"/></Icon>,
  Repeat:   (p) => <Icon {...p}><path d="M4 9l3-3h11a1 1 0 011 1v5"/><path d="M20 15l-3 3H6a1 1 0 01-1-1v-5"/></Icon>,
  Copy:     (p) => <Icon {...p}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 012-2h10"/></Icon>,
  Trash:    (p) => <Icon {...p}><path d="M4 7h16M9 7V5a1.5 1.5 0 011.5-1.5h3A1.5 1.5 0 0115 5v2M6 7l1 12.5A1.5 1.5 0 008.5 21h7a1.5 1.5 0 001.5-1.5L18 7"/></Icon>,
  Heart:    (p) => <Icon {...p}><path d="M12 20s-7-4.5-7-10a4 4 0 017-2.5A4 4 0 0119 10c0 5.5-7 10-7 10z"/></Icon>,
  Trophy:   (p) => <Icon {...p}><path d="M8 4h8v5a4 4 0 01-8 0V4z"/><path d="M8 6H5v2a3 3 0 003 3M16 6h3v2a3 3 0 01-3 3"/><path d="M9 19h6M10 16v3M14 16v3"/></Icon>,
  Logo: ({ size = 28, color = 'currentColor' }) => (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <path d="M20 4 C12 4, 7 10, 7 18 C7 28, 20 36, 20 36 C20 36, 33 28, 33 18 C33 10, 28 4, 20 4 Z"
            stroke={color} strokeWidth="2" strokeLinejoin="round"/>
      <path d="M14 18 L18 22 L26 14" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
};

window.Icons = Icons;
