// /copyright - how to report something on an Ivy-hosted page that copies
// someone's work, and what Ivy does about it.
//
// Ivy hosts what its customers add: website words and photos, community
// posts, reviews. A stated notice-and-removal process is what the law
// expects of a host. Registering a designated agent with the US Copyright
// Office is a separate step the company does itself.
import React from 'react';
import LegalPage, { H2, P } from './LegalPage.jsx';

const mail = { color: 'var(--accent)' };

export default function CopyrightPage() {
  return (
    <LegalPage title="Reporting copyright infringement" lastUpdated="November 19, 2026" path="/copyright"
      description="How to report content on a page hosted by Ivy that copies your work without permission, and what happens after you report it.">
      <P>
        Businesses that use Ivy add their own words, photos and videos to
        their pages. If you believe something on a page hosted by Ivy copies
        your work without permission, tell us and we will act on it.
      </P>

      <H2>How to report it</H2>
      <P>
        Email{' '}
        <a href="mailto:support@joinivy.ai" style={mail}>support@joinivy.ai</a>{' '}
        with:
      </P>
      <ol style={{ margin: '8px 0 8px 20px', padding: 0 }}>
        <li>Your name, address, phone number and email.</li>
        <li>What work of yours was copied.</li>
        <li>The web address of the page where it appears.</li>
        <li>A statement that you believe in good faith the use is not allowed by the owner, its agent or the law.</li>
        <li>A statement, under penalty of perjury, that your notice is accurate and that you are the owner or are allowed to act for the owner.</li>
        <li>Your signature. Typing your full name is fine.</li>
      </ol>

      <H2>What happens next</H2>
      <P>
        When we get a complete notice we remove or hide the material and
        tell the business that posted it. If they believe it was removed by
        mistake, they can send us a counter-notice with the same kind of
        details, and we will pass it to you.
      </P>
      <P>
        Businesses that repeatedly post material that infringes copyright
        lose their accounts.
      </P>

      <H2>Where to send notices by mail</H2>
      <P>
        Ivy AI LLC, 24930 Washington Avenue Unit #268, Murrieta, CA 92564, USA
      </P>
    </LegalPage>
  );
}
