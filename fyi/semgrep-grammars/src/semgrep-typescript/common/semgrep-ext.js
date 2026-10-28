/*
 * A partial tree-sitter grammar object containing the semgrep extensions to the
 * typescript grammar. This way, these extensions can be reused in both the TSX
 * and the TS grammars.
 *
 * Even if we only use one of these parsers to parse patterns, it's simpler to
 * keep the CSTs the same and there's little downside in doing so.
 */
const commaSep1 = (rule) => seq(rule, repeat(seq(',', rule)));
const sepBy1 = (sep, rule) => seq(rule, repeat(seq(sep, rule)));

module.exports = {
  // `import(...)` after `typeof` reads both as a call and as a type query.
  // Upstream makes the call win, so `f<typeof import("m")>()` fails as an
  // instantiation; the conflict below keeps both readings.
  precedences: ($, previous) => previous.filter((group) => !(
    group.length === 2 &&
    group[0].name === 'call_expression' &&
    group[1].name === '_type_query_call_expression'
  )),

  conflicts: ($, previous) => previous.concat([
    [$.semgrep_expression_ellipsis, $.spread_element],
    [$.semgrep_expression_ellipsis, $.rest_pattern],
    [$.semgrep_expression_ellipsis, $.rest_type],
    [$.semgrep_expression_ellipsis, $.rest_type, $.spread_element, $.rest_pattern],
    [$.semgrep_expression_ellipsis, $.spread_element, $.rest_pattern],
    [$.semgrep_expression_ellipsis, $.semgrep_ellipsis],
    [$.call_expression, $._type_query_call_expression],
    // `using [a] = x` assigns to `using[a]`.
    [$.primary_expression, $.using_declaration],
    // Flow
    [$.primary_type, $.flow_component_type],
    [$.conditional_type, $.flow_renders_annotation],
    [$.union_type, $.flow_renders_annotation],
    [$.intersection_type, $.flow_renders_annotation],
    [$._formal_parameter, $.flow_function_type_parameters],
    [$.primary_expression, $.flow_component_type],
    [$.primary_expression, $.decorator_member_expression],
    [$.primary_expression, $.decorator_parenthesized_expression],
    [$.primary_expression, $.decorator_call_expression],
    [$.primary_type, $.flow_maybe_type],
    [$.flow_maybe_type, $.function_type],
    [$.lookup_type, $.flow_maybe_type, $.array_type],
    [$.parenthesized_type, $.flow_function_type_parameters],
    [$.rest_pattern, $.predefined_type],
    [$.rest_pattern, $.literal_type],
    [$.rest_pattern, $.primary_type],
    [$.lexical_declaration, $.primary_type],
    [$.index_type_query, $.function_type],
    [$.rest_pattern, $.rest_type, $.semgrep_expression_ellipsis],
    [$.index_signature, $.flow_variance],
    [$.type, $.function_type],
    [$.arrow_function, $.predefined_type],
    [$.arrow_function, $.primary_type],
  ]),

  rules: {
    program: ($, previous) => choice(
      previous,
      // Used as a semgrep pattern
      $.switch_case,
    ),

    /*
      semgrep metavariables are already valid javascript/typescript
      identifiers so we do nothing for them.
    */

    semgrep_ellipsis: $ => '...',

    /* ellipsis in function parameters
     * e.g. function foo(..., x, ...)
     */
    _formal_parameter: $ => choice(
      $.semgrep_ellipsis,
      $.required_parameter,
      $.optional_parameter,
    ),

    /* This part is copied from the original grammar to add `$.semgrep_ellipsis`
     * as one of the choices. Make sure it is in sync with the original grammar
     * and update it if necessary.
     * TODO: update the original grammar to include an intermediate `class_element`
     * rule so that we can avoid copying and pasting the original rule here.
     *
     * Decorators may precede every member, not only method definitions and
     * fields, so that a decorated method signature or index signature parses;
     * `public_field_definition` carries none of its own.
     */
    class_body: $ => seq(
      '{',
      repeat(choice(
        $.semgrep_ellipsis,
        seq(
          repeat(field('decorator', $.decorator)),
          choice(
            seq($.method_definition, optional($._semicolon)),
            // As it happens for functions, the semicolon insertion should not
            // happen if a block follows the closing paren, because then it's a
            // *definition*, not a declaration. Example:
            //     public foo()
            //     { <--- this brace made the method signature become a definition
            //     }
            // The same rule applies for functions and that's why we use
            // "_function_signature_automatic_semicolon".
            seq($.method_signature, choice($._function_signature_automatic_semicolon, ',')),
            seq(
              choice(
                $.abstract_method_signature,
                $.index_signature,
                $.method_signature,
                $.public_field_definition,
              ),
              choice($._semicolon, ','),
            ),
          ),
        ),
        $.class_static_block,
        ';',
      )),
      '}',
    ),

/* TODO: restore this when the changes are made in semgrep.
   Remove the XXXXXXX when uncommenting.

   You also need to restore the test file:
     lang/semgrep-grammars/src/semgrep-typescript/tsx/corpus/semgrep-ext.txt
   See the original PR:
     https://github.com/semgrep/ocaml-tree-sitter-semgrep/pull/488

    semgrep_metavar_ellipsis: $ => /\$\.\.\.[A-Z_][A-Z_0-9]*XXXXXXX/,
/*
    /* In the expression context, there are LR(1) conflicts with spread and
     * rest. I (nmote) don't think that these are true ambiguities, but just in
     * case we'll declare conflicts and set this to low dynamic precedence so as
     * to avoid incorrectly parsing target programs. */
    semgrep_expression_ellipsis: $ => prec.dynamic(-1337, '...'),

    primary_expression: ($, previous) => choice(
      previous,
      $.semgrep_expression_ellipsis,
    ),

/* TODO: restore this when the changes are made in semgrep.
    _jsx_attribute: ($, previous) => choice(
      previous,
      $.semgrep_ellipsis,
      $.semgrep_metavar_ellipsis
    ),
*/
    // Upstream's alternatives come first, restated with a dynamic precedence
    // on the type arguments of a call. `f<(x: A) => B<C>>(y)` also reads as
    // `f < ((x: A) => B < (C >> (y)))`; without it the two readings tie, and
    // tree-sitter breaks the tie by symbol numbers, which the overlay shifts.
    // TypeScript reads a call.
    //
    // A tagged template takes type arguments (sql<number>`...`). It has the
    // precedence of a call with type arguments, which the parser tells apart
    // from comparisons through the declared conflicts.
    call_expression: $ => choice(
      choice(
        prec('call', seq(
          field('function', choice($.expression, $.import)),
          field('type_arguments', optional(prec.dynamic(1, $.type_arguments))),
          field('arguments', $.arguments),
        )),
        prec('template_call', seq(
          field('function', choice($.primary_expression, $.new_expression)),
          field('arguments', $.template_string),
        )),
        prec('member', seq(
          field('function', $.primary_expression),
          '?.',
          field('type_arguments', optional($.type_arguments)),
          field('arguments', $.arguments),
        )),
      ),
      prec('call', seq(
        field('function', $.expression),
        field('type_arguments', $.type_arguments),
        field('arguments', $.template_string),
      )),
    ),

    // JSX text may contain an `&` that starts no character reference
    // (`Tom & Jerry`), and a `>` (`A -> B`), which JSX parsers accept; the
    // scanner stops at both.
    _jsx_child: ($, previous) => choice(
      previous,
      alias('&', $.jsx_text),
      alias('>', $.jsx_text),
    ),

    // A decimal reference has up to 7 digits (U+10FFFF is 1114111).
    html_character_reference: _ =>
      /&(#([xX][0-9a-fA-F]{1,6}|[0-9]{1,7})|[A-Za-z]{1,30});/,

    // A JSX attribute string ends at its quote only; an `&` that starts no
    // reference (`href="?a=1&b=2"`, `"&"`) is text.
    unescaped_double_jsx_string_fragment: _ =>
      token.immediate(prec(1, /[^"]+/)),
    unescaped_single_jsx_string_fragment: _ =>
      token.immediate(prec(1, /[^']+/)),

    // Variance annotations (TypeScript 4.7). `out` is not a reserved word,
    // so `<out>` is a type parameter that carries the identifier `out`.
    type_parameter: $ => seq(
      optional($.flow_variance),
      optional('const'),
      optional('in'),
      choice(
        seq('out', field('name', $._type_identifier)),
        field('name', choice(
          $._type_identifier,
          alias('out', $.type_identifier),
        )),
      ),
      field('constraint', optional($.constraint)),
      field('value', optional($.default_type)),
    ),

    // `export type * from` and `export type * as ns from` (TypeScript 5.0),
    // and import attributes on a re-export, `export * from "m" with {...}`.
    export_statement: ($, previous) => choice(
      previous,
      seq(
        'export',
        'type',
        choice('*', $.namespace_export),
        $._from_clause,
        $._semicolon,
      ),
      seq(
        'export',
        choice(
          seq('*', $._from_clause),
          seq($.namespace_export, $._from_clause),
          seq($.export_clause, $._from_clause),
        ),
        $.import_attribute,
        $._semicolon,
      ),
    ),

    // `using`, Flow's `opaque`, `component` and `hook`, and the class member
    // modifiers `accessor` and `abstract` remain identifiers elsewhere, as in
    // `accessor: number` and `abstract;`.
    _reserved_identifier: (_, previous) => choice(
      previous,
      'accessor',
      'abstract',
      'using',
      'opaque',
      'component',
      'hook',
    ),

    declaration: ($, previous) => choice(
      previous,
      $.using_declaration,
      $.flow_opaque_type_declaration,
      $.flow_component_declaration,
      $.flow_hook_declaration,
    ),

    // `using x = e` and `await using x = e` (explicit resource management),
    // as in tree-sitter-javascript 0.25. Upstream TypeScript reads `using`
    // as a prefix of any assignment instead, which turns `using.x = 1` into
    // a declaration.
    using_declaration: $ => seq(
      field('kind', choice('using', seq('await', 'using'))),
      commaSep1($.variable_declarator),
      $._semicolon,
    ),

    assignment_expression: $ => prec.right('assign', seq(
      field('left', choice($.parenthesized_expression, $._lhs_expression)),
      '=',
      field('right', $.expression),
    )),

    // `for (using x = e; ...)` and `for (await using x = e; ...)`
    for_statement: $ => seq(
      'for',
      '(',
      choice(
        field('initializer', choice(
          $.lexical_declaration,
          $.variable_declaration,
          $.using_declaration,
        )),
        seq(field('initializer', $._expressions), ';'),
        field('initializer', $.empty_statement),
      ),
      field('condition', choice(
        seq($._expressions, ';'),
        $.empty_statement,
      )),
      field('increment', optional($._expressions)),
      ')',
      field('body', $.statement),
    ),

    // `for (using x of xs)` and `for (await using x of xs)`. A `using`
    // binding is an identifier: `for (using[a] of xs)` assigns to `using[a]`.
    _for_header: $ => seq(
      '(',
      choice(
        field('left', choice(
          $._lhs_expression,
          $.parenthesized_expression,
        )),
        seq(
          field('kind', 'var'),
          field('left', choice(
            $.identifier,
            $._destructuring_pattern,
          )),
          optional($._initializer),
        ),
        seq(
          field('kind', choice('let', 'const')),
          field('left', choice(
            $.identifier,
            $._destructuring_pattern,
          )),
          optional($._automatic_semicolon),
        ),
        seq(
          field('kind', choice('using', seq('await', 'using'))),
          field('left', $.identifier),
          optional($._automatic_semicolon),
        ),
      ),
      field('operator', choice('in', 'of')),
      field('right', $._expressions),
      ')',
    ),

    // Flow, the type dialect of JavaScript files. Its syntax is accepted
    // next to TypeScript's; each form below is invalid TypeScript.

    // `declare export ...`, `declare component ...`, `declare hook ...`
    ambient_declaration: ($, previous) => choice(
      previous,
      seq(
        'declare',
        choice(
          seq(
            'export',
            choice(
              $.declaration,
              seq(
                'default',
                choice($.declaration, seq($.type, $._semicolon)),
              ),
            ),
          ),
          $.flow_component_signature,
          $.flow_hook_signature,
        ),
      ),
    ),

    // `opaque type T: Super = U`; a declared one has no `= U`.
    flow_opaque_type_declaration: $ => seq(
      'opaque',
      'type',
      field('name', $._type_identifier),
      field('type_parameters', optional($.type_parameters)),
      optional(seq(':', field('supertype', $.type))),
      optional(seq('=', field('value', $.type))),
      $._semicolon,
    ),

    flow_component_declaration: $ => seq(
      'component',
      field('name', $.identifier),
      field('type_parameters', optional($.type_parameters)),
      field('parameters', $.flow_component_parameters),
      optional($.flow_renders_annotation),
      field('body', $.statement_block),
    ),

    flow_component_signature: $ => seq(
      'component',
      field('name', $.identifier),
      field('type_parameters', optional($.type_parameters)),
      field('parameters', $.flow_component_parameters),
      optional($.flow_renders_annotation),
      $._semicolon,
    ),

    flow_component_parameters: $ => seq(
      '(',
      optional(seq(
        commaSep1(choice(
          $.flow_component_parameter,
          $.flow_component_rest_parameter,
        )),
        optional(','),
      )),
      ')',
    ),

    // `name: T`, `name as local: T`, `'data-x' as local: T`, with an optional
    // `?` and default value
    flow_component_parameter: $ => seq(
      field('name', choice(
        $.identifier,
        alias($._reserved_identifier, $.identifier),
        $.string,
      )),
      optional(seq(
        'as',
        field('local', choice($.identifier, $._destructuring_pattern)),
      )),
      optional('?'),
      field('type', optional($.type_annotation)),
      optional($._initializer),
    ),

    flow_component_rest_parameter: $ => seq(
      '...',
      field('pattern', choice($.identifier, $._destructuring_pattern)),
      field('type', optional($.type_annotation)),
    ),

    flow_renders_annotation: $ => seq(
      choice('renders', 'renders?', 'renders*'),
      $.type,
    ),

    flow_hook_declaration: $ => seq(
      'hook',
      field('name', $.identifier),
      $._call_signature,
      field('body', $.statement_block),
    ),

    flow_hook_signature: $ => seq(
      'hook',
      field('name', $.identifier),
      $._call_signature,
      $._semicolon,
    ),

    // `{a: T, ...}` (inexact) and `{...A, b: U}` (spread)
    object_type: $ => seq(
      choice('{', '{|'),
      optional(seq(
        optional(choice(',', ';')),
        sepBy1(
          choice(',', $._semicolon),
          choice(
            $.export_statement,
            $.property_signature,
            $.call_signature,
            $.construct_signature,
            $.index_signature,
            $.method_signature,
            $.flow_object_type_spread,
          ),
        ),
        optional(choice(',', $._semicolon)),
      )),
      choice('}', '|}'),
    ),

    flow_object_type_spread: $ => seq('...', optional($.type)),

    // `+x: T` (covariant) and `-x: T` (contravariant)
    flow_variance: _ => choice('+', '-'),

    property_signature: $ => seq(
      optional($.accessibility_modifier),
      optional('static'),
      optional($.override_modifier),
      optional('readonly'),
      optional($.flow_variance),
      field('name', $._property_name),
      optional('?'),
      field('type', optional($.type_annotation)),
    ),

    index_signature: $ => seq(
      optional(choice(
        seq(
          field('sign', optional(choice('-', '+'))),
          'readonly',
        ),
        $.flow_variance,
      )),
      '[',
      choice(
        seq(
          field('name', choice(
            $.identifier,
            alias($._reserved_identifier, $.identifier),
          )),
          ':',
          field('index_type', $.type),
        ),
        $.mapped_type_clause,
      ),
      ']',
      field('type', choice(
        $.type_annotation,
        $.omitting_type_annotation,
        $.adding_type_annotation,
        $.opting_type_annotation,
      )),
    ),

    // `T => U`, and `(T, U) => V` whose parameters carry no names. Their
    // dynamic precedence keeps the TypeScript reading of `(x): T => e` and
    // `(x) => void`; it outweighs the -1 that every pattern carries. A
    // predefined type alone in a parameter list, as in `(string) => void`,
    // takes Flow's reading, a parameter of that type: upstream reads
    // `(string` as the start of a parenthesised type and rejects the arrow.
    function_type: ($, previous) => choice(
      previous,
      prec.dynamic(-1000, seq(
        field('parameter', $.primary_type),
        '=>',
        field('return_type', $.type),
      )),
      prec.dynamic(-1000, prec.right(seq(
        field('type_parameters', optional($.type_parameters)),
        field('parameters', $.flow_function_type_parameters),
        '=>',
        field('return_type', $.type),
      ))),
    ),

    // Each parameter is a type, or carries a name as in TypeScript.
    flow_function_type_parameters: $ => seq(
      '(',
      commaSep1(choice(
        $.type,
        $.rest_type,
        $.required_parameter,
        $.optional_parameter,
      )),
      optional(','),
      ')',
    ),

    // `?T` and `?() => T`. Upstream's right associativity is dropped: after
    // `(x): ?T` it took the `=>` for a Flow function type before the arrow
    // function's reading was tried. The dynamic precedence keeps `?T[]` as
    // `?(T[])`, which the associativity used to decide.
    flow_maybe_type: $ => choice(
      seq('?', $.primary_type),
      prec.dynamic(1, seq('?', $.array_type)),
      prec.right(seq(
        '?',
        field('type_parameters', optional($.type_parameters)),
        field('parameters', choice(
          $.formal_parameters,
          $.flow_function_type_parameters,
        )),
        '=>',
        field('return_type', $.type),
      )),
    ),

    // `@@iterator` and `@@asyncIterator`, Flow's names of the well-known
    // symbols in declarations
    _property_name: ($, previous) => choice(
      previous,
      $.flow_symbol_name,
    ),

    flow_symbol_name: _ => /@@[a-zA-Z_$][a-zA-Z0-9_$]*/,

    // `accessor` after `static`, `override` or `abstract`, and `+x: T` on
    // class fields, as in Flow library declarations. Each form is a fixed
    // sequence: the same modifiers as independent optional elements, each of
    // which can also be a field name, make the parse table too large to
    // generate.
    public_field_definition: $ => seq(
      optional(choice(
        seq('declare', optional($.accessibility_modifier)),
        seq($.accessibility_modifier, optional('declare')),
      )),
      choice(
        seq(optional('static'), optional($.override_modifier), optional('readonly')),
        seq(optional('abstract'), optional('readonly')),
        seq(optional('readonly'), optional('abstract')),
        optional('accessor'),
        seq('static', 'accessor'),
        seq($.override_modifier, 'accessor'),
        seq('abstract', 'accessor'),
        seq(optional('static'), $.flow_variance),
      ),
      field('name', $._property_name),
      optional(choice('?', '!')),
      field('type', optional($.type_annotation)),
      optional($._initializer),
    ),

    // `import("m").T` and `import("m")` are primary types, so that they take
    // `[]` and `[K]` (`import("m").T[]`); upstream lists them under `type`.
    type: $ => choice(
      $.primary_type,
      $.function_type,
      $.readonly_type,
      $.constructor_type,
      $.infer_type,
    ),

    // `component(...props: P)` (the type of a component), `interface {...}`
    // and `interface extends A {...}` (inline interface types). `component`
    // is lexed as a keyword in a type, so it is listed as a type name too.
    primary_type: ($, previous) => choice(
      previous,
      $.flow_component_type,
      $.flow_interface_type,
      alias('component', $.type_identifier),
      prec(-1, alias($._type_query_member_expression_in_type_annotation, $.member_expression)),
      prec(-1, alias($._type_query_call_expression_in_type_annotation, $.call_expression)),
    ),

    // `x is component`: as upstream lists the predefined types, `component`
    // is listed because a type predicate is lexed as a type.
    type_predicate: $ => seq(
      field('name', choice(
        $.identifier,
        $.this,
        alias($.predefined_type, $.identifier),
        alias('component', $.identifier),
      )),
      'is',
      field('type', $.type),
    ),

    flow_component_type: $ => seq(
      'component',
      field('parameters', $.flow_component_parameters),
      optional($.flow_renders_annotation),
    ),

    flow_interface_type: $ => seq(
      'interface',
      optional($.extends_type_clause),
      field('body', $.object_type),
    ),

    // `Map<>`: empty type arguments, inferred by Flow
    generic_type: ($, previous) => choice(
      previous,
      prec('call', seq(
        field('name', choice($._type_identifier, $.nested_type_identifier)),
        field('type_arguments', $.flow_empty_type_arguments),
      )),
    ),

    flow_empty_type_arguments: _ => seq('<', '>'),

    // `@(expression)`: a decorator may be any parenthesised expression
    // (TypeScript 5)
    decorator_parenthesized_expression: $ => seq(
      '(',
      choice(
        $.identifier,
        alias($.decorator_member_expression, $.member_expression),
        alias($.decorator_call_expression, $.call_expression),
        prec.dynamic(-1000, $.expression),
      ),
      ')',
    ),

    // `function f(x): boolean %checks { ... }` and the declared form with
    // `%checks(e)`
    _call_signature: $ => seq(
      field('type_parameters', optional($.type_parameters)),
      field('parameters', $.formal_parameters),
      field('return_type', optional(choice(
        $.type_annotation,
        $.asserts_annotation,
        $.type_predicate_annotation,
        $.flow_predicate_annotation,
      ))),
    ),

    flow_predicate_annotation: $ => seq(
      ':',
      optional($.type),
      '%checks',
      optional($.parenthesized_expression),
    ),
  }
}
