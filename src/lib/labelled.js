// Gives a form control its name for screen readers and voice control.
//
// Most forms here draw a caption above a control (<div>Amount</div> then an
// <input>). Sighted people read the two as a pair; assistive technology
// does not, unless the control itself carries the name. The small Field
// wrappers around the app call labelled(children, label) so the caption
// they already show is also the control's accessible name.
//
// Only a single plain input, select or textarea is touched, and only when
// it has no name of its own. Anything else is returned untouched.
import { cloneElement, isValidElement } from 'react';

const CONTROLS = new Set(['input', 'select', 'textarea']);

export function labelled(children, label) {
  if (typeof label !== 'string' || !label.trim()) return children;
  if (!isValidElement(children) || !CONTROLS.has(children.type)) return children;
  const p = children.props || {};
  if (p['aria-label'] || p['aria-labelledby'] || p.id) return children;
  return cloneElement(children, { 'aria-label': label.trim() });
}
