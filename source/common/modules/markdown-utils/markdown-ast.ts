/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        parseNode
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains a converter that can take in a Markdown
 *                  source string and convert it to an Abstract Syntax Tree.
 *                  This file follows the advice of Marijn Haverbeke, who
 *                  mentioned that Lezer trees are not necessarily "abstract"
 *                  and hence need to be converted prior to utilizing the tree:
 *
 *                  "These trees, represented by data structures from the
 *                  @lezer/common package, are more limited than the abstract
 *                  syntax trees you might have seen in other contexts. They are
 *                  not very abstract."
 *                  (from: https://lezer.codemirror.net/docs/guide/)
 *
 *                  The utility function runs the Markdown parser as defined for
 *                  the main editor to ensure that every element that the user
 *                  can see in the editor will also end up represented here. The
 *                  syntax tree is primarily used in two different instances
 *                  across the app:
 *
 *                  1. To extract only the text nodes (Readability Mode & spell
 *                     checking)
 *                  2. To "copy as HTML" (see markdown-to-html)
 *
 * END HEADER
 */

import extractCitations, { CitePosition } from '@common/util/extract-citations'
import { SyntaxNode } from '@lezer/common'

/**
 * This list contains all Node names that do not themselves have any content.
 * These are either purely formatting nodes (such as heading marks or link
 * marks) who can be reconstructed without the verbatim value, as well as larger
 * container nodes (whose contents is represented via their children).
 *
 * @var {string[]}
 */
const EMPTY_NODES = [
  'HeaderMark',
  'CodeMark',
  'EmphasisMark',
  'QuoteMark',
  'ListMark',
  'YAMLFrontmatterStart',
  'YAMLFrontmatterEnd',
  'Document',
  'List',
  'ListItem',
  'PandocAttribute'
]

/**
 * Basic info every ASTNode needs to provide
 */
interface MDNode {
  /**
   * The node.name property (may differ; significant mainly for generics)
   */
  name: string
  /**
   * The start offset of this node in the original source
   */
  from: number
  /**
   * The end offset of this node in the original source
   */
  to: number
  /**
   * Can be used to store arbitrary attributes (e.g. Pandoc-style attributes
   * such as {.className})
   */
  attributes?: Record<string, string>
}

/**
 * Represents a footnote (the indicator within the text itself, not the
 * reference).
 */
export interface Footnote extends MDNode {
  type: 'Footnote'
  /**
   * If this is true, this means that the label is actually the footnote's
   * context, whereas label will be the footnote ref number if its false.
   */
  inline: boolean
  /**
   * The label of the footnote (sans the formatting, i.e. [^1] -> 1)
   */
  label: string
}

/**
 * A footnote reference, complete with label and footnote body.
 */
export interface FootnoteRef extends MDNode {
  type: 'FootnoteRef'
  /**
   * The label of the footnote (sans the formatting, i.e. [^1]: -> 1)
   */
  label: string
  /**
   * A list of children representing the footnote's body
   */
  children: ASTNode[]
}

/**
 * Either a link or an image, since the difference between these two nodes
 * consists of a single character.
 */
export interface LinkOrImage extends MDNode {
  type: 'Link'|'Image'
  /**
   * The URL of the link or image
   */
  url: TextNode
  /**
   * ALT text of the link or image (i.e. what's written in square brackets)
   */
  alt: TextNode
  /**
   * Optional title text (i.e. what can be added after the URL in quotes)
   */
  title?: TextNode
}

/**
 * Represents a Heading.
 */
export interface Heading extends MDNode {
  type: 'Heading'
  /**
   * The heading's content
   */
  value: TextNode
  /**
   * Level from 1-6
   */
  level: number
}

/**
 * A citation element
 */
export interface Citation extends MDNode {
  type: 'Citation'
  /**
   * The unparsed, raw citation code
   */
  value: TextNode
  /**
   * The parsed citation code that can be used to render the citation
   */
  parsedCitation: CitePosition
}

/**
 * A highlight, e.g., encapsulated ==in equality signs==
 */
export interface Highlight extends MDNode {
  type: 'Highlight'
  /**
   * Since it's a regular inline element, it can have children
   */
  children: ASTNode[]
}

/**
 * A single list item.
 */
export interface ListItem extends MDNode {
  type: 'ListItem'
  /**
   * An optional property. If it exists, it is a task item, and then the
   * property dictates whether it was checked or not.
   */
  checked?: boolean
  /**
   * A property that includes information about the list item marker.
   */
  marker: {
    /**
     * The symbol used for the list item. Only present for unordered lists.
     */
    symbol?: '*'|'-'|'+'
    /**
     * The start of the symbol.
     */
    from: number
    /**
     * The end of the symbol.
     */
    to: number
  }
  /**
   * A list item can contain an arbitrary amount of child nodes. Adding "List"
   * as an explicit child to signify that nested lists are children of an item.
   */
  children: Array<List|ASTNode>
}

/**
 * Represents a list.
 */
export interface List extends MDNode {
  type: 'List'
  /**
   * Whether the list is ordered (enumerated) or bulleted (itemized)
   */
  ordered: boolean
  /**
   * A set of list items
   */
  items: ListItem[]
}

/**
 * Represents a fenced code. NOTE that CodeBlocks are also treated as FencedCode.
 */
export interface FencedCode extends MDNode {
  type: 'FencedCode'
  /**
   * The info string (can be an empty string, e.g., for indented code)
   */
  info: string
  /**
   * The verbatim source code. (Not represented as a TextNode since whitespace
   * is significant)
   */
  source: string
}

/**
 * Represents inline code.
 */
export interface InlineCode extends MDNode {
  type: 'InlineCode'
  /**
   * The verbatim source code. (Not represented as a TextNode since whitespace
   * is significant)
   */
  source: string
}

/**
 * An emphasis node (italic or bold).
 */
export interface Emphasis extends MDNode {
  type: 'Emphasis'
  /**
   * The type of emphasis -- italic or bold
   */
  which: 'italic'|'bold'
  /**
   * The children of this node
   */
  children: ASTNode[]
}

/**
 * This node represents a YAML frontmatter. It shares a lot with the FencedCode
 * type, i.e. the YAML code will not be parsed into an object.
 */
export interface YAMLFrontmatter extends MDNode {
  type: 'YAMLFrontmatter'
  /**
   * The info string will always be yaml frontmatter.
   */
  info: string
  /**
   * The verbatim YAML source.
   */
  source: string
}

/**
 * Represents a single table cell
 */
export interface TableCell extends MDNode {
  type: 'TableCell'
  /**
   * The text content of the cell TODO: Arbitrary children!
   */
  children: ASTNode[]
}

/**
 * Represents a table row.
 */
export interface TableRow extends MDNode {
  type: 'TableRow'
  /**
   * This is set to true if the row is a header.
   */
  isHeaderOrFooter: boolean
  /**
   * A list of cells within this row
   */
  cells: TableCell[]
}

/**
 * Represents a table element.
 */
export interface Table extends MDNode {
  type: 'Table'
  /**
   * A list of rows of this table
   */
  rows: TableRow[]
}

/**
 * Represents a ZettelkastenLink (`[[Some file.md]]`)
 */
export interface ZettelkastenLink extends MDNode {
  type: 'ZettelkastenLink'
  /**
   * Contains the raw contents of the link
   */
  value: TextNode
}

/**
 * Represents a tag (`#some-tag`)
 */
export interface ZettelkastenTag extends MDNode {
  type: 'ZettelkastenTag'
  /**
   * Contains the raw contents of the tag
   */
  value: TextNode
}

/**
 * A generic text node that can represent a string of content. Most nodes
 * contain at least one TextNode as its content (e.g. emphasis).
 */
export interface TextNode extends MDNode {
  type: 'Text'
  /**
   * The string value of the text node.
   */
  value: string
}

/**
 * This generic node represents any Lezer node that has no specific role (or can
 * be handled without additional care). This ensures that new nodes will always
 * end up in the resulting AST, even if we forgot to add the node specifically.
 */
export interface GenericNode extends MDNode {
  type: 'Generic'
  /**
   * Each generic node may have children
   */
  children: ASTNode[]
}

/**
 * Any node that can be part of the AST is an ASTNode.
 */
export type ASTNode = Footnote | FootnoteRef | LinkOrImage | TextNode | Heading | Citation | Highlight | List | ListItem | GenericNode | FencedCode | InlineCode | YAMLFrontmatter | Emphasis | Table | TableCell | TableRow | ZettelkastenLink | ZettelkastenTag
/**
 * Extract the "type" properties from the ASTNodes that can differentiate these.
 */
export type ASTNodeType = ASTNode['type']

/**
 * Creates a generic text node; this is used to represent textual contents of
 * SyntaxNodes.
 *
 * @param   {number}    from   The start offset (absolute; zero-indexed)
 * @param   {number}    to     The end offset (absolute; zero-indexed)
 * @param   {string}    value  The actual text
 *
 * @return  {TextNode}         The rendered TextNode
 */
function genericTextNode (from: number, to: number, value: string): TextNode {
  return { type: 'Text', name: 'text', from, to, value }
}

/**
 * Parses an attribute node (PandocAttribute), according to the Pandoc rules
 * (mostly). cf.: https://pandoc.org/MANUAL.html#extension-attributes
 *
 * @param   {Record<string, string>}  oldAttributes  Attribute nodes are merged.
 * @param   {SyntaxNode}              node           The SyntaxNode
 * @param   {string}                  markdown       The original markdown
 *
 * @return  {Record<string, string>}                 A map of the attributes
 */
function parseAttributeNode (oldAttributes: Record<string, string> = {}, node: SyntaxNode, markdown: string): Record<string, string> {
  if (node.name !== 'PandocAttribute') {
    return oldAttributes
  }

  const rawString: string = markdown.substring(node.from + 1, node.to - 1) // Remove { and }
  const rawAttributes: string[] = rawString.split(/\s+/)
  // General syntax: {#identifier .class .class key=value key=value}
  for (const attribute of rawAttributes) {
    if (attribute.startsWith('.')) {
      // It's a class
      if ('class' in oldAttributes) {
        oldAttributes.class = oldAttributes.class + ' ' + attribute.substring(1)
      } else {
        oldAttributes.class = attribute.substring(1)
      }
    } else if (attribute.startsWith('#') && !('id' in oldAttributes)) {
      // It's an ID, but only the *first* one found counts
      oldAttributes.id = attribute.substring(1)
    } else if (attribute.includes('=')) {
      // It's a key=value attribute. NOTE: Later generic attributes override
      // earlier ones!
      const parts: string[] = attribute.split('=')
      if (parts.length === 2) {
        oldAttributes[parts[0]] = parts[1]
      } // Else: Invalid
    }
  }
  return oldAttributes
}

/**
 * Parses the children of ASTNodes who can have children.
 *
 * @param   {T}           astNode   The AST node that must support children
 * @param   {SyntaxNode}  node      The original Lezer SyntaxNode
 * @param   {string}      markdown  The Markdown source
 *
 * @return  {T}                     Returns the same astNode with children.
 */
function parseChildren<T extends { children: ASTNode[] } & MDNode> (astNode: T, node: SyntaxNode, markdown: string): T {
  if (node.firstChild === null) {
    if (!EMPTY_NODES.includes(node.name)) {
      const textNode = genericTextNode(node.from, node.to, markdown.substring(node.from, node.to))
      astNode.children = [textNode]
    }
    return astNode // We're done
  }

  astNode.children = []

  let currentChild: SyntaxNode|null = node.firstChild
  let currentIndex = node.from
  while (currentChild !== null) {
    // NOTE: We have to account for "gaps" where a node has children that do not
    // completely cover the node's contents. In that case, we have to add text
    // nodes that just contain those strings.
    if (currentChild.from > currentIndex && !EMPTY_NODES.includes(node.name)) {
      const gap = markdown.substring(currentIndex, currentChild.from)
      const textNode = genericTextNode(currentIndex, currentChild.from, gap)
      astNode.children.push(textNode)
    }
    if (currentChild.name === 'PandocAttribute') {
      // PandocAttribute nodes should never show up in the tree
      // TODO: This assumes that the PandocAttribute should apply to the parent
      // node, but often (e.g., for images) they belong to the previous child!
      // TODO: Check what the *previous* child was, and if it can have attributes
      // Docs: https://pandoc.org/MANUAL.html#extension-attributes
      astNode.attributes = parseAttributeNode(astNode.attributes, currentChild, markdown)
    } else {
      astNode.children.push(parseNode(currentChild, markdown))
    }
    currentIndex = currentChild.to // Must happen before the nextSibling assignment
    currentChild = currentChild.nextSibling
  }

  if (currentIndex < node.to && !EMPTY_NODES.includes(node.name)) {
    // One final text node
    const textNode = genericTextNode(currentIndex, node.to, markdown.substring(currentIndex, node.to))
    astNode.children.push(textNode)
  }

  return astNode
}

/**
 * Parses a single Lezer style SyntaxNode to an ASTNode.
 *
 * @param   {SyntaxNode}  node      The node to convert
 * @param   {string}      markdown  The Markdown source, required to extract the
 *                                  actual text content of the SyntaxNodes,
 *                                  which isn't stored in the nodes themselves.
 *
 * @return  {ASTNode}               The root node of a Markdown AST
 */
export function parseNode (node: SyntaxNode, markdown: string): ASTNode {
  switch (node.name) {
    // NOTE: Most nodes are treated as generics (see default case); here we only
    // define nodes which we can "compress" a little bit or make accessible
    case 'Image':
    case 'Link': {
      const alt = node.getChild('LinkLabel')
      const url = node.getChild('URL')
      if (url === null) {
        return {
          type: 'Generic',
          name: node.name,
          from: node.from,
          to: node.to,
          children: [genericTextNode(node.from, node.to, markdown.substring(node.from, node.to))]
        }
      }

      const astNode: LinkOrImage = {
        type: node.name,
        name: node.name,
        from: node.from,
        to: node.to,
        // title: genericTextNode(node.from, node.to, markdown.substring(node.from, node.to)), TODO
        url: genericTextNode(url.from, url.to, markdown.substring(url.from, url.to)),
        alt: genericTextNode(url.from, url.to, markdown.substring(url.from, url.to))
      }

      const marks = node.getChildren('LinkMark')

      if (alt === null && marks.length >= 2) {
        // The default Markdown parser doesn't apply "LinkLabel" unfortunately.
        // So instead we have to get whatever is in between the first and second
        // linkMark.
        astNode.alt = genericTextNode(marks[0].to, marks[1].from, markdown.substring(marks[0].to, marks[1].from))
      } // Else: Somewhat malformed link.

      return astNode
    }
    case 'URL': {
      const astNode: LinkOrImage = {
        type: 'Link',
        name: node.name,
        from: node.from,
        to: node.to,
        // title: genericTextNode(node.from, node.to, markdown.substring(node.from, node.to)), TODO
        url: genericTextNode(node.from, node.to, markdown.substring(node.from, node.to)),
        alt: genericTextNode(node.from, node.to, markdown.substring(node.from, node.to))
      }
      return astNode
    }
    case 'ATXHeading1':
    case 'ATXHeading2':
    case 'ATXHeading3':
    case 'ATXHeading4':
    case 'ATXHeading5':
    case 'ATXHeading6': {
      const mark = node.getChild('HeaderMark')
      const level = mark !== null ? mark.to - mark.from : 0
      const astNode: Heading = {
        type: 'Heading',
        name: node.name,
        from: node.from,
        to: node.to,
        value: genericTextNode(mark?.to ?? node.from, node.to, markdown.substring(mark?.to ?? node.from, node.to).trim()),
        level
      }
      return astNode
    }
    case 'SetextHeading1':
    case 'SetextHeading2': {
      const mark = node.getChild('HeaderMark')
      const level = mark !== null && markdown.substring(mark.from, mark.to).includes('-') ? 2 : 1
      const astNode: Heading = {
        type: 'Heading',
        name: node.name,
        from: node.from,
        to: node.to,
        value: genericTextNode(mark?.to ?? node.from, node.to, markdown.substring(node.from, mark?.from ?? node.to).trim()),
        level
      }
      return astNode
    }
    case 'Citation': {
      const astNode: Citation = {
        name: 'Citation',
        type: 'Citation',
        value: genericTextNode(node.from, node.to, markdown.substring(node.from, node.to)),
        parsedCitation: extractCitations(markdown.substring(node.from, node.to))[0],
        from: node.from,
        to: node.to
      }
      return astNode
    }
    case 'Footnote': {
      const contents = markdown.substring(node.from + 2, node.to - 1) // [^1] --> 1
      const astNode: Footnote = {
        type: 'Footnote',
        name: 'Footnote',
        from: node.from,
        inline: contents.endsWith('^'),
        to: node.to,
        label: contents.endsWith('^') ? contents.substring(0, contents.length - 1) : contents
      }
      return astNode
    }
    case 'FootnoteRef': {
      const label = node.getChild('FootnoteRefLabel')
      const body = node.getChild('FootnoteRefBody')
      const astNode: FootnoteRef = {
        type: 'FootnoteRef',
        name: 'FootnoteRef',
        from: node.from,
        to: node.to,
        label: label !== null ? markdown.substring(label.from + 2, label.to - 2) : '',
        children: []
      }

      if (body !== null) {
        return parseChildren(astNode, body, markdown)
      } else {
        return astNode
      }
    }
    case 'Highlight': {
      const content = node.getChild('HighlightContent')
      const astNode: Highlight = {
        type: 'Highlight',
        name: 'Highlight',
        from: node.from,
        to: node.to,
        children: []
      }
      return parseChildren(astNode, content ?? node, markdown)
    }
    case 'OrderedList':
    case 'BulletList': {
      const astNode: List = {
        type: 'List',
        name: node.name,
        ordered: node.name === 'OrderedList',
        from: node.from,
        to: node.to,
        items: []
      }

      for (const item of node.getChildren('ListItem')) {
        const listItem: ListItem = {
          type: 'ListItem',
          name: 'ListItem',
          from: item.from,
          to: item.to,
          children: [],
          marker: {
            symbol: undefined,
            from: item.from,
            to: item.from
          }
        }

        // Identify list marker properties
        const listMark = item.getChild('ListMark')
        if (listMark !== null) {
          listItem.marker.from = listMark.from
          listItem.marker.to = listMark.to

          if (!astNode.ordered && listMark.to - listMark.from === 1) {
            listItem.marker.symbol = markdown.substring(listMark.from, listMark.to) as '+'|'-'|'*'
          }
        }

        // Identify potential task item
        const task = item.getChild('Task')
        const taskMarker = task !== null ? task.getChild('TaskMarker') : null
        if (taskMarker !== null) {
          const text = markdown.substring(taskMarker.from, taskMarker.to)
          listItem.checked = text === '[x]'
        }

        astNode.items.push(parseChildren(listItem, item, markdown))
      }

      return astNode
    }
    case 'FencedCode':
    case 'CodeBlock': {
      let info = node.getChild('CodeInfo')
      const mark = node.getChild('CodeMark')
      if (mark !== null) {
        const codeMark = markdown.substring(mark.from, mark.to)
        if (codeMark === '$$') {
          // Exchange the (nonexistent) infostring with the double-dollars so
          // that consumers can detect that this is MathTex
          info = mark
        }
      }
      const source = node.getChild('CodeText')
      const isFrontmatter = node.getChild('YAMLFrontmatterStart') !== null
      const astNode: FencedCode|YAMLFrontmatter = {
        type: isFrontmatter ? 'YAMLFrontmatter' : 'FencedCode',
        name: isFrontmatter ? 'YAMLFrontmatter' : 'FencedCode',
        from: node.from,
        to: node.to,
        info: info !== null ? markdown.substring(info.from, info.to) : '',
        source: source !== null ? markdown.substring(source.from, source.to) : ''
      }
      return astNode
    }
    case 'InlineCode': {
      const [ start, end ] = node.getChildren('CodeMark')
      const astNode: InlineCode = {
        type: 'InlineCode',
        name: 'InlineCode',
        from: node.from,
        to: node.to,
        source: markdown.substring(start.to, end.from)
      }
      return astNode
    }
    case 'Emphasis':
    case 'StrongEmphasis': {
      const astNode: Emphasis = {
        type: 'Emphasis',
        name: 'Emphasis',
        which: node.name === 'Emphasis' ? 'italic' : 'bold',
        from: node.from,
        to: node.to,
        children: []
      }

      return parseChildren(astNode, node, markdown)
    }
    case 'Table': {
      const astNode: Table = {
        type: 'Table',
        name: 'Table',
        from: node.from,
        to: node.to,
        rows: []
      }
      const header = node.getChildren('TableHeader')
      const rows = node.getChildren('TableRow')
      for (const row of [ ...header, ...rows ]) {
        const rowNode: TableRow = {
          type: 'TableRow',
          name: row.name,
          from: row.from,
          to: row.to,
          isHeaderOrFooter: row.name === 'TableHeader',
          cells: []
        }
        for (const cell of row.getChildren('TableCell')) {
          const cellNode: TableCell = {
            type: 'TableCell',
            name: 'TableCell',
            from: cell.from,
            to: cell.to,
            children: []
          }
          rowNode.cells.push(parseChildren(cellNode, cell, markdown))
        }
        astNode.rows.push(rowNode)
      }
      return astNode
    }
    case 'ZknLink': {
      const content = node.getChild('ZknLinkContent')
      if (content === null) {
        throw new Error('Could not parse node ZknLink: No ZknLinkContent node found within children!')
      }

      const astNode: ZettelkastenLink = {
        type: 'ZettelkastenLink',
        name: 'ZknLink',
        from: node.from,
        to: node.to,
        value: genericTextNode(content.from, content.to, markdown.substring(content.from, content.to))
      }
      return astNode
    }
    case 'ZknTag': {
      const astNode: ZettelkastenTag = {
        type: 'ZettelkastenTag',
        name: 'ZknTag',
        from: node.from,
        to: node.to,
        value: genericTextNode(node.from, node.to, markdown.substring(node.from, node.to))
      }
      return astNode
    }
    default: {
      const astNode: GenericNode = {
        type: 'Generic',
        name: node.name,
        from: node.from,
        to: node.to,
        children: []
      }
      return parseChildren(astNode, node, markdown)
    }
  }
}
