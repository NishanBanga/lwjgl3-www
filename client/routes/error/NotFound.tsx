import { useDocumentTitle } from '~/hooks/useDocumentTitle';

export const NotFound: React.FC<{ children?: never }> = () => {
  useDocumentTitle('Page not Found');
  return (
    <section className="container text-center py-5">
      <h1>404</h1>
      <h3>Page not found</h3>
    </section>
  );
};
