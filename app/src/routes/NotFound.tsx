import { Link } from "react-router";

export function NotFound() {
  return <main>
    <title>Page not found · Juno Voice</title>
    <meta name="robots" content="noindex" />
    <section className="hero" aria-labelledby="not-found-title">
      <div>
        <p className="eyebrow">JUNO VOICE</p>
        <h1 id="not-found-title">Page not found</h1>
        <p>This address does not match any Juno Voice page. The public record is still available from the landing page.</p>
        <p><Link className="button" to="/">Go to the landing page</Link></p>
      </div>
    </section>
  </main>;
}
