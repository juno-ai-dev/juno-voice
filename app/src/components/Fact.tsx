export function Fact({ label, value, title, href }: { label: string; value: string; title?: string; href?: string }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong title={title}>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        ) : (
          value
        )}
      </strong>
    </div>
  );
}
