import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

// FOUND IN THE UI TEST (R527). While a dialog or sheet is open the page sets
// pointer-events: none on everything outside it, toasts included: a toast was
// drawn on top of the approvals inbox but could not be clicked, and a click on
// its Review button went THROUGH it to the Approve button of the card beneath,
// approving something nobody meant to. Toasts take their own clicks, always.
//
// FOUND FROM THE UI. A toast had no height limit, and many show text from
// elsewhere (an error from the server, a guardrail's refusal, a file name): a
// refusal quoting a long topic made a toast taller than the screen, over the
// whole chat and off its top. A toast's title and description now hold a few
// lines each and scroll for the rest, and a long unbroken word wraps.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group pointer-events-auto"
      toastOptions={{
        classNames: {
          toast:
            "group toast pointer-events-auto group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          content: "min-w-0",
          title: "max-h-20 overflow-y-auto wrap-anywhere",
          description:
            "group-[.toast]:text-muted-foreground max-h-32 overflow-y-auto wrap-anywhere",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
