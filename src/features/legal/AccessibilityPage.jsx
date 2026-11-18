// /accessibility - what Ivy does to be usable by people with disabilities,
// what is not finished, and how to report a barrier.
//
// Everything stated here is something the product does or a check that has
// been run. It deliberately makes no claim of full conformance: an honest
// "this is the standard we work to, this is what is tested, this is how to
// tell us" is both more useful and safer than a certification we do not hold.
import React from 'react';
import LegalPage, { H2, P, UL } from './LegalPage.jsx';

const mail = { color: 'var(--accent)' };

export default function AccessibilityPage() {
  return (
    <LegalPage title="Accessibility" lastUpdated="November 18, 2026" path="/accessibility"
      description="How Ivy works to be usable by people with disabilities, what has been tested, what is not finished, and how to report a barrier.">
      <P>
        We want Ivy to work for everyone, including people who use a screen
        reader, a keyboard instead of a mouse, voice control, or larger text.
        This page covers the Ivy website, the Ivy app, and the pages Ivy
        creates for the businesses that use it: booking pages, client
        portals, invoices, and documents to sign.
      </P>

      <H2>The standard we work to</H2>
      <P>
        We build and test against the Web Content Accessibility Guidelines
        (WCAG) 2.1, Level AA. We do not claim that every part of Ivy meets
        every guideline today. We test, fix what we find, and keep going.
      </P>

      <H2>What we do</H2>
      <UL>
        <li>Buttons, links and form fields have names a screen reader can announce.</li>
        <li>Pages are built to be used with a keyboard, and the item in focus is outlined.</li>
        <li>Text is checked for contrast against its background.</li>
        <li>Images that carry meaning have a text description.</li>
        <li>Pages are laid out to work on small screens as well as large ones.</li>
        <li>Buttons on touch screens have a comfortable tap area.</li>
        <li>We run automated accessibility checks on the website, the booking page, sign-up, the app and the client portal, and review the results by hand.</li>
      </UL>

      <H2>What is not finished</H2>
      <UL>
        <li>Automated checks do not catch everything. Parts of the app have not yet been tested end to end with a screen reader.</li>
        <li>Some dense screens, such as the calendar and the website builder, are harder to use with a keyboard alone than we would like.</li>
        <li>Businesses add their own words, photos, videos and colors to their Ivy pages. We give them accessible building blocks, but we do not control what they add.</li>
        <li>Card payment forms and embedded videos come from other companies and follow their own accessibility practices.</li>
      </UL>

      <H2>Tell us about a problem</H2>
      <P>
        If something in Ivy is hard or impossible for you to use, email{' '}
        <a href="mailto:support@joinivy.ai" style={mail}>support@joinivy.ai</a>{' '}
        with the page you were on and what happened. We read every report,
        reply to you, and work on a fix. If you need information from Ivy in
        another format, ask at the same address.
      </P>
      <P>
        If the problem is on a page that belongs to a business using Ivy,
        such as their booking page, you can tell us and we will look at our
        part of it and let the business know about theirs.
      </P>
    </LegalPage>
  );
}
