import { cn } from "@/lib/utils";

/**
 * Etiqueta de un campo. Con `required` agrega un asterisco rojo (decorativo: los
 * lectores de pantalla lo reciben como "obligatorio" por el texto oculto).
 */
export function Label({
  className,
  required,
  children,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean }) {
  return (
    <label
      className={cn(
        "text-sm font-medium leading-none text-foreground",
        className
      )}
      {...props}
    >
      {children}
      {required && (
        <>
          <span aria-hidden className="ml-0.5 font-semibold text-danger-text">
            *
          </span>
          <span className="sr-only"> (obligatorio)</span>
        </>
      )}
    </label>
  );
}
