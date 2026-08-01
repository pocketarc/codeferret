There is no rendered page in this session, and no browser, screen reader or contrast tool
to point at one. What you have is the source in the diff.

That covers a real share of WCAG statically: missing alternative text, an unlabelled form
control, a heading level skipped, a handler on a non-interactive element, a `tabindex`
above zero, an ARIA attribute on a role that does not take it, a language attribute, a
table without headers.

It does not cover the criteria that need computed styles or a live focus ring: 1.4.3 and
1.4.11 contrast, 2.4.3 focus order, 2.4.7 focus visibility, 2.5.5 target size, 1.4.10
reflow. Do not report those as passing, and do not guess at them from source colours
whose background you cannot see.

Name in `notes` the criteria you could not evaluate without rendering. The review shows
your notes to the reader, and without them a pull request full of interface changes comes
back looking as though its accessibility had been checked.
