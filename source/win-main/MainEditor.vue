<template>
  <div
    ref="editor"
    class="main-editor-wrapper"
    v-bind:style="{ 'font-size': `${fontSize}px` }"
    v-bind:class="{
      'code-file': !isMarkdown,
      'fullscreen': distractionFree
    }"
    v-on:dragenter="handleDragEnter($event, 'editor')"
    v-on:dragleave="handleDragLeave($event)"
    v-on:drop="handleDrop($event, 'editor')"
  >
    <div v-bind:id="`cm-text-${props.leafId}`">
      <!-- This element will be replaced with Codemirror's wrapper element on mount -->
    </div>

    <div
      v-if="documentTabDrag"
      v-bind:class="{
        dropzone: true,
        top: true,
        dragover: documentTabDragWhere === 'top'
      }"
      v-on:drop="handleDrop($event, 'top')"
      v-on:dragenter="handleDragEnter($event, 'top')"
      v-on:dragleave="handleDragLeave($event)"
    >
      <cds-icon v-if="documentTabDragWhere === 'top'" shape="angle" direction="up"></cds-icon>
    </div>
    <div
      v-if="documentTabDrag"
      v-bind:class="{
        dropzone: true,
        left: true,
        dragover: documentTabDragWhere === 'left'
      }"
      v-on:drop="handleDrop($event, 'left')"
      v-on:dragenter="handleDragEnter($event, 'left')"
      v-on:dragleave="handleDragLeave($event)"
    >
      <cds-icon v-if="documentTabDragWhere === 'left'" shape="angle" direction="left"></cds-icon>
    </div>
    <div
      v-if="documentTabDrag"
      v-bind:class="{
        dropzone: true,
        bottom: true,
        dragover: documentTabDragWhere === 'bottom'
      }"
      v-on:drop="handleDrop($event, 'bottom')"
      v-on:dragenter="handleDragEnter($event, 'bottom')"
      v-on:dragleave="handleDragLeave($event)"
    >
      <cds-icon v-if="documentTabDragWhere === 'bottom'" shape="angle" direction="down"></cds-icon>
    </div>
    <div
      v-if="documentTabDrag"
      v-bind:class="{
        dropzone: true,
        right: true,
        dragover: documentTabDragWhere === 'right'
      }"
      v-on:drop="handleDrop($event, 'right')"
      v-on:dragenter="handleDragEnter($event, 'right')"
      v-on:dragleave="handleDragLeave($event)"
    >
      <cds-icon v-if="documentTabDragWhere === 'right'" shape="angle" direction="right"></cds-icon>
    </div>
  </div>
</template>

<script setup lang="ts">

/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Editor
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This displays the main editor for the app. It uses the
 *                  MarkdownEditor class to implement the full CodeMirror editor.
 *
 * END HEADER
 */

import MarkdownEditor from '@common/modules/markdown-editor'
import objectToArray from '@common/util/object-to-array'

import { ref, computed, onMounted, watch, toRef } from 'vue'
import { useStore } from 'vuex'
import { key as storeKey } from './store'
import { EditorCommands } from '@dts/renderer/editor'
import { hasMarkdownExt } from '@providers/fsal/util/is-md-or-code-file'
import { DP_EVENTS } from '@dts/common/documents'
import { CITEPROC_MAIN_DB } from '@dts/common/citeproc'
import { EditorConfigOptions } from '@common/modules/markdown-editor/util/configuration'
import { CodeFileDescriptor, MDFileDescriptor } from '@dts/common/fsal'
import getBibliographyForDescriptor from '@common/util/get-bibliography-for-descriptor'
import { EditorSelection } from '@codemirror/state'
import { TagRecord } from '@providers/tags'
import { documentAuthorityIPCAPI } from '@common/modules/markdown-editor/util/ipc-api'

const ipcRenderer = window.ipc
const path = window.path

const props = defineProps({
  leafId: {
    type: String,
    required: true
  },
  windowId: {
    type: String,
    required: true
  },
  editorCommands: {
    type: Object as () => EditorCommands,
    required: true
  },
  distractionFree: {
    type: Boolean,
    required: true
  }
})

const emit = defineEmits<{(e: 'globalSearch', query: string): void}>()

const store = useStore(storeKey)

// TEMPLATE REFS
const editor = ref<HTMLDivElement|null>(null)

// UNREFFED STUFF
let mdEditor: MarkdownEditor|null = null

// EVENT LISTENERS
ipcRenderer.on('citeproc-database-updated', (event, dbPath: string) => {
  const descriptor = activeFileDescriptor.value
  const activeDoc = activeFile.value

  if (descriptor === undefined || descriptor.type !== 'file' || activeDoc == null) {
    return // Nothing to do
  }

  const library = getBibliographyForDescriptor(descriptor)
  updateCitationKeys(library).catch(e => {
    console.error('Could not update citation keys', e)
  })
})

ipcRenderer.on('shortcut', (event, command) => {
  if (mdEditor?.hasFocus() !== true) {
    return // None of our business
  }

  const file = activeFile.value

  if (command === 'save-file' && file != null) {
    // Main is telling us to save, so tell main to save the current file.
    ipcRenderer.invoke('documents-provider', {
      command: 'save-file',
      payload: { path: file.path }
    })
      .then(result => {
        if (result !== true) {
          console.error('Retrieved a falsy result from main, indicating an error with saving the file.')
        }
      })
      .catch(e => console.error(e))
  } else if (command === 'search') {
    showSearch.value = !showSearch.value
  } else if (command === 'toggle-typewriter-mode') {
    mdEditor.hasTypewriterMode = !mdEditor.hasTypewriterMode
  } else if (command === 'copy-as-html') {
    mdEditor.copyAsHTML()
  }
})

ipcRenderer.on('documents-update', (e, { event, context }) => {
  if (event === DP_EVENTS.FILE_REMOTELY_CHANGED && context === activeFile.value?.path) {
    // The currently loaded document has been changed remotely. This event indicates
    // that the document provider has already reloaded the document and we only
    // need to tell the main editor to reload it as well.
    mdEditor?.reload().catch(e => console.error(e))
  }
})

// Update the file database whenever links have been updated
ipcRenderer.on('links', e => {
  updateFileDatabase().catch(err => console.error('Could not update file database', err))
})

// MOUNTED HOOK
onMounted(() => {
  // As soon as the component is mounted, initiate the editor
  mdEditor = new MarkdownEditor(undefined, props.leafId, documentAuthorityIPCAPI)

  const wrapper = document.getElementById(`cm-text-${props.leafId}`)

  if (wrapper === null) {
    throw new Error('Could not mount editor: Target wrapper not found!')
  }

  wrapper.replaceWith(mdEditor.dom)

  // Update the document info on corresponding events
  mdEditor.on('change', () => {
    store.commit('updateTableOfContents', mdEditor?.tableOfContents)
  })

  mdEditor.on('cursorActivity', () => {
    // Don't update every keystroke to not run into performance problems with
    // very long documents, since calculating the word count needs considerable
    // time, and without the delay, typing seems "laggy".
    if (mdEditor !== null) {
      store.commit('activeDocumentInfo', mdEditor.documentInfo)
    }
  })

  mdEditor.on('focus', () => {
    store.dispatch('lastLeafId', props.leafId).catch(err => console.error(err))
    if (mdEditor !== null) {
      store.commit('updateTableOfContents', mdEditor.tableOfContents)
    }
  })

  mdEditor.on('zettelkasten-link', (linkContents) => {
    ipcRenderer.invoke('application', {
      command: 'force-open',
      payload: {
        linkContents,
        newTab: undefined, // let open-file command decide based on preferences
        leafId: props.leafId,
        windowId: props.windowId
      }
    })
      .catch(err => console.error(err))

    if (store.state.config['zkn.autoSearch'] === true) {
      emit('globalSearch', linkContents)
    }
  })

  mdEditor.on('zettelkasten-tag', (tag) => {
    emit('globalSearch', tag)
  })

  // Lastly, run the initial load cycle
  loadActiveFile().catch(err => console.error(err))
  if (activeFile.value == null) {
    activeFileDescriptor.value = undefined
  } else {
    ipcRenderer.invoke('application', {
      command: 'get-descriptor',
      payload: activeFile.value.path
    })
      .then(descriptor => {
        activeFileDescriptor.value = descriptor
      })
      .catch(err => console.error(err))
  }

  // Supply the configuration object once initially
  mdEditor.setOptions(editorConfiguration.value)
  mdEditor.darkMode = darkMode.value
})

// DATA SETUP
const showSearch = ref(false)
const documentTabDrag = ref(false)
const documentTabDragWhere = ref<undefined|string>(undefined)

// COMPUTED PROPERTIES
const useH1 = computed<boolean>(() => store.state.config.fileNameDisplay.includes('heading'))
const useTitle = computed<boolean>(() => store.state.config.fileNameDisplay.includes('title'))
const filenameOnly = computed<boolean>(() => store.state.config['zkn.linkFilenameOnly'])
const fontSize = computed<number>(() => store.state.config['editor.fontSize'])
const globalSearchResults = computed(() => store.state.searchResults)
const node = computed(() => store.state.paneData.find(leaf => leaf.id === props.leafId))
const activeFile = computed(() => node.value?.activeFile) // TODO: MAYBE REMOVE
const lastLeafId = computed(() => store.state.lastLeafId)
const snippets = computed(() => store.state.snippets)
const darkMode = computed(() => store.state.config.darkMode)

const activeFileDescriptor = ref<undefined|MDFileDescriptor|CodeFileDescriptor>(undefined)

const editorConfiguration = computed<EditorConfigOptions>(() => {
  // We update everything, because not so many values are actually updated
  // right after setting the new configurations. Plus, the user won't update
  // everything all the time, but rather do one initial configuration, so
  // even if we incur a performance penalty, it won't be noticed that much.
  return {
    indentUnit: store.state.config['editor.indentUnit'],
    indentWithTabs: store.state.config['editor.indentWithTabs'],
    autoCloseBrackets: store.state.config['editor.autoCloseBrackets'],
    autocorrect: {
      active: store.state.config['editor.autoCorrect.active'],
      style: store.state.config['editor.autoCorrect.style'],
      magicQuotes: {
        primary: store.state.config['editor.autoCorrect.magicQuotes.primary'],
        secondary: store.state.config['editor.autoCorrect.magicQuotes.secondary']
      },
      replacements: store.state.config['editor.autoCorrect.replacements']
    },
    imagePreviewWidth: store.state.config['display.imageWidth'],
    imagePreviewHeight: store.state.config['display.imageHeight'],
    boldFormatting: store.state.config['editor.boldFormatting'],
    italicFormatting: store.state.config['editor.italicFormatting'],
    muteLines: store.state.config.muteLines,
    citeStyle: store.state.config['editor.citeStyle'],
    readabilityAlgorithm: store.state.config['editor.readabilityAlgorithm'],
    idRE: store.state.config['zkn.idRE'],
    idGen: store.state.config['zkn.idGen'],
    renderCitations: store.state.config['display.renderCitations'],
    renderIframes: store.state.config['display.renderIframes'],
    renderImages: store.state.config['display.renderImages'],
    renderLinks: store.state.config['display.renderLinks'],
    renderMath: store.state.config['display.renderMath'],
    renderTasks: store.state.config['display.renderTasks'],
    renderHeadings: store.state.config['display.renderHTags'],
    renderTables: store.state.config['editor.enableTableHelper'],
    renderEmphasis: store.state.config['display.renderEmphasis'],
    linkPreference: store.state.config['zkn.linkWithFilename'],
    linkFilenameOnly: store.state.config['zkn.linkFilenameOnly'],
    inputMode: store.state.config['editor.inputMode'],
    lintMarkdown: store.state.config['editor.lint.markdown'],
    // The editor only needs to know if it should use languageTool
    lintLanguageTool: store.state.config['editor.lint.languageTool.active'],
    distractionFree: props.distractionFree.valueOf(),
    showStatusbar: store.state.config['editor.showStatusbar']
  } as EditorConfigOptions
})

// External commands/"event" system
watch(toRef(props.editorCommands, 'jumpToLine'), () => {
  const { filePath, lineNumber } = props.editorCommands.data
  // Execute a jtl-command if the current displayed file is the correct one
  if (filePath === activeFile.value?.path) {
    jtl(lineNumber)
  }
})
watch(toRef(props.editorCommands, 'moveSection'), () => {
  if (lastLeafId.value !== props.leafId) {
    return
  }
  const { from, to } = props.editorCommands.data
  mdEditor?.moveSection(from, to)
})
watch(toRef(props.editorCommands, 'readabilityMode'), (newValue) => {
  if (lastLeafId.value !== props.leafId) {
    return
  }

  if (mdEditor !== null) {
    mdEditor.readabilityMode = !mdEditor.readabilityMode
    if (mdEditor.readabilityMode) {
      store.commit('addReadabilityActiveLeaf', props.leafId)
    } else {
      store.commit('removeReadabilityActiveLeaf', props.leafId)
    }
  }
})

watch(toRef(props, 'distractionFree'), (newValue) => {
  if (mdEditor !== null) {
    mdEditor.distractionFree = props.distractionFree
  }
})

watch(toRef(props.editorCommands, 'executeCommand'), () => {
  if (lastLeafId.value !== props.leafId) {
    return
  }
  const command: string = props.editorCommands.data
  mdEditor?.runCommand(command)
  mdEditor?.focus()
})
watch(toRef(props.editorCommands, 'replaceSelection'), () => {
  if (lastLeafId.value !== props.leafId) {
    return
  }
  const textToInsert: string = props.editorCommands.data
  mdEditor?.replaceSelection(textToInsert)
})
watch(darkMode, () => {
  if (mdEditor !== null) {
    mdEditor.darkMode = darkMode.value
  }
})

const isMarkdown = computed(() => {
  if (activeFile.value == null) {
    return true // By default, assume Markdown
  }

  return hasMarkdownExt(activeFile.value.path)
})

const fsalFiles = computed<MDFileDescriptor[]>(() => {
  const tree = store.state.fileTree
  const files = []

  for (const item of tree) {
    if (item.type === 'directory') {
      const contents = objectToArray(item, 'children').filter(descriptor => descriptor.type === 'file')
      files.push(...contents)
    } else if (item.type === 'file') {
      files.push(item)
    }
  }

  return files
})

// WATCHERS
watch(useH1, () => { updateFileDatabase().catch(err => console.error('Could not update file database', err)) })
watch(useTitle, () => { updateFileDatabase().catch(err => console.error('Could not update file database', err)) })
watch(filenameOnly, () => { updateFileDatabase().catch(err => console.error('Could not update file database', err)) })
watch(fsalFiles, () => { updateFileDatabase().catch(err => console.error('Could not update file database', err)) })

watch(activeFile, async () => {
  // Request the descriptor and put it into our ref
  if (activeFile.value == null) {
    activeFileDescriptor.value = undefined
  } else {
    const descriptor = await ipcRenderer.invoke('application', {
      command: 'get-descriptor',
      payload: activeFile.value.path
    })
    activeFileDescriptor.value = descriptor
  }
})

watch(editorConfiguration, (newValue) => {
  mdEditor?.setOptions(newValue)
})

watch(globalSearchResults, () => {
  // TODO: I don't like that we need a timeout here.
  setTimeout(maybeHighlightSearchResults, 200)
})

watch(activeFile, async () => {
  await loadActiveFile()
})

watch(snippets, (newValue) => {
  mdEditor?.setCompletionDatabase('snippets', newValue)
})

// METHODS
async function loadActiveFile () {
  if (mdEditor === null) {
    throw new Error('Received a file update but the editor was not yet initiated!')
  }

  if (activeFile.value == null) {
    // TODO: REMOVE DOCUMENT!
    mdEditor.emptyEditor()
    store.commit('updateTableOfContents', mdEditor.tableOfContents)
    // Update the citation keys with an empty array
    mdEditor.setCompletionDatabase('citations', [])
    return
  }

  swapDocument(activeFile.value.path).catch(err => console.error(err))
}

async function swapDocument (doc: string) {
  if (mdEditor === null) {
    console.error(`Could not swap to document ${doc}: Editor was not initialized`)
    return
  }

  if (activeFile.value == null) {
    console.error(`Could not swap to document ${doc}: Was not yet set as active file!`)
    return
  }

  const descriptor: MDFileDescriptor|CodeFileDescriptor = await ipcRenderer.invoke('application', { command: 'get-descriptor', payload: doc })

  if (descriptor === undefined) {
    throw new Error(`Could not swap document: Could not retrieve descriptor for path ${doc}!`)
  }

  const library = descriptor.type === 'file' ? getBibliographyForDescriptor(descriptor) : undefined

  await mdEditor.swapDoc(doc)
  store.commit('updateTableOfContents', mdEditor?.tableOfContents)
  store.commit('activeDocumentInfo', mdEditor?.documentInfo)
  // Check if there are search results available for this file that we can
  // pull in and highlight
  maybeHighlightSearchResults()
  // Update the citation keys
  if (library !== undefined) {
    updateCitationKeys(library).catch(e => console.error('Could not update citation keys', e))
  }

  mdEditor.setCompletionDatabase('snippets', snippets.value)

  const tags = await ipcRenderer.invoke('tag-provider', { command: 'get-all-tags' }) as TagRecord[]
  mdEditor.setCompletionDatabase('tags', tags)

  // Provide the editor instance with metadata for the new file
  mdEditor.setOptions({
    metadata: {
      path: doc,
      id: descriptor.type === 'file' ? descriptor.id : '',
      library: library ?? CITEPROC_MAIN_DB
    }
  })
}

function jtl (lineNumber: number) {
  if (mdEditor !== null) {
    mdEditor.jtl(lineNumber)
  }
}

// eslint-disable-next-line no-unused-vars
async function updateCitationKeys (library: string): Promise<void> {
  if (mdEditor === null) {
    return
  }

  const items: any[] = (await ipcRenderer.invoke('citeproc-provider', {
    command: 'get-items',
    payload: { database: library }
  }))
    .map((item: any) => {
      // Get a rudimentary author list. Precedence are authors, then editors.
      // Fallback: Container title.
      let authors = ''
      const authorSrc = item.author !== undefined
        ? item.author
        : item.editor !== undefined ? item.editor : []

      if (authorSrc.length > 0) {
        authors = authorSrc.map((author: any) => {
          if (author.family !== undefined) {
            return author.family
          } else if (author.literal !== undefined) {
            return author.literal
          } else {
            return undefined
          }
        }).filter((elem: any) => elem !== undefined).join(', ')
      } else if (item['container-title'] !== undefined) {
        authors = item['container-title']
      }

      let title = ''
      if (item.title !== undefined) {
        title = item.title
      } else if (item['container-title'] !== undefined) {
        title = item['container-title']
      }

      let date = ''
      if (item.issued !== undefined) {
        if ('date-parts' in item.issued) {
          const year = item.issued['date-parts'][0][0]
          date = ` (${year})`
        } else if ('literal' in item.issued) {
          date = ` (${item.issued.literal})`
        }
      }

      // This is just a very crude representation of the citations.
      return {
        citekey: item.id,
        displayText: `${authors}${date} - ${title}`
      }
    })

  mdEditor.setCompletionDatabase('citations', items)
}

async function updateFileDatabase () {
  if (mdEditor === null) {
    return
  }

  // Get all our files ...
  const fileDatabase: Array<{ filename: string, displayName: string, id: string }> = []

  // ... and the unique links that are part of the link database
  const rawLinks: Record<string, string[]> = await ipcRenderer.invoke('link-provider', { command: 'get-link-database' })
  const linkDatabase = [...new Set(Object.values(rawLinks).flat())]

  // First, add all existing files to the database ...
  for (const file of fsalFiles.value) {
    let displayName = path.basename(file.name, file.ext)
    if (useTitle.value && file.yamlTitle !== undefined) {
      displayName = file.yamlTitle
    } else if (useH1.value && file.firstHeading !== null) {
      displayName = file.firstHeading
    }
    fileDatabase.push({
      filename: path.basename(file.name, file.ext),
      displayName,
      id: file.id
    })
  }

  // ... before going through the link database to add those links that link to
  // not yet existing files
  for (const link of linkDatabase) {
    const existingFile = fileDatabase.find(file => file.filename === link || file.id === link)
    if (existingFile === undefined) {
      // Non-existing link
      fileDatabase.push({ filename: link, displayName: link, id: '' })
    }
  }

  mdEditor.setCompletionDatabase('files', fileDatabase)
}

function maybeHighlightSearchResults () {
  const doc = activeFile.value
  if (doc == null || mdEditor === null) {
    return // No open file/no editor
  }

  const result = globalSearchResults.value.find(r => r.file.path === doc.path)
  if (result === undefined) {
    mdEditor.highlightRanges([])
    return
  }

  // Construct CodeMirror.Ranges from the results
  const rangesToHighlight = []
  // NOTE: We have to filter out "whole-file" results
  for (const res of result.result.filter(res => res.line > -1)) {
    const startIdx = mdEditor.instance.state.doc.line(res.line + 1).from
    for (const range of res.ranges) {
      const { from, to } = range
      rangesToHighlight.push(EditorSelection.range(startIdx + from, startIdx + to))
    }
  }
  mdEditor.highlightRanges(rangesToHighlight)
}

function handleDrop (event: DragEvent, where: 'editor'|'top'|'left'|'right'|'bottom') {
  const DELIM = (process.platform === 'win32') ? ';' : ':'
  const documentTab = event.dataTransfer?.getData('zettlr/document-tab')
  if (documentTab !== undefined && documentTab.includes(DELIM)) {
    documentTabDrag.value = false
    event.stopPropagation()
    event.preventDefault()
    // At this point, we have received a drop we need to handle it. There
    // are two possibilities: Either the user has dropped the file onto the
    // editor, which means the file should be moved from its origin here.
    // Or, the user has dropped the file onto one of the four edges. In that
    // case, we need to first split this specific leaf, and then move the
    // dropped file there. The drag data contains both the origin and the
    // path, separated by the $PATH delimiter -> window:leaf:absPath
    const [ originWindow, originLeaf, filePath ] = documentTab.split(DELIM)
    if (where === 'editor' && props.leafId === originLeaf) {
      // Nothing to do, the user dropped the file on the origin
      return false
    }

    // Now actually perform the act
    if (where === 'editor') {
      ipcRenderer.invoke('documents-provider', {
        command: 'move-file',
        payload: {
          originWindow,
          targetWindow: props.windowId,
          originLeaf,
          targetLeaf: props.leafId,
          path: filePath
        }
      })
        .catch(err => console.error(err))
    } else {
      const dir = ([ 'left', 'right' ].includes(where)) ? 'horizontal' : 'vertical'
      const ins = ([ 'top', 'left' ].includes(where)) ? 'before' : 'after'
      ipcRenderer.invoke('documents-provider', {
        command: 'split-leaf',
        payload: {
          originWindow: props.windowId,
          originLeaf: props.leafId,
          direction: dir,
          insertion: ins,
          path: filePath,
          fromWindow: originWindow,
          fromLeaf: originLeaf
        }
      })
        .catch(err => console.error(err))
    }
  }
}

function handleDragEnter (event: DragEvent, where: 'editor'|'top'|'left'|'right'|'bottom') {
  const hasDocumentTab = event.dataTransfer?.types.includes('zettlr/document-tab') ?? false
  if (hasDocumentTab) {
    event.stopPropagation()
    documentTabDrag.value = true
    documentTabDragWhere.value = where
  }
}

function handleDragLeave (event: DragEvent) {
  const hasDocumentTab = event.dataTransfer?.types.includes('zettlr/document-tab') ?? false
  if (hasDocumentTab && editor.value !== null) {
    const bounds = editor.value.getBoundingClientRect()
    const outX = event.clientX < bounds.left || event.clientX > bounds.right
    const outY = event.clientY < bounds.top || event.clientY > bounds.bottom
    if (outX || outY) {
      documentTabDrag.value = false
      documentTabDragWhere.value = undefined
    }
  }
}

</script>

<style lang="less">
// Editor Geometry

// Editor margins left and right for all breakpoints in both fullscreen and
// normal mode.
@editor-margin-fullscreen-sm:  50px;
@editor-margin-fullscreen-md:   5vw;
@editor-margin-fullscreen-lg:  10vw;
@editor-margin-fullscreen-xl:  20vw;
@editor-margin-fullscreen-xxl: 30vw;

@dropzone-size: 60px;

.main-editor-wrapper {
  width: 100%;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  background-color: #ffffff;
  transition: 0.2s background-color ease;
  position: relative;

  &.fullscreen {
    position: fixed;
    z-index: 100; // Ensure this editor instance is on top of any other pane
    bottom: 0;
    left: 0;
    right: 0;
  }

  @keyframes caretup {
    from { margin-bottom: 0; opacity: 1; }
    50% { opacity: 0; }
    75% { margin-bottom: @dropzone-size; opacity: 0; }
    to { margin-bottom: @dropzone-size; opacity: 0; }
  }
  @keyframes caretdown {
    from { margin-top: 0; opacity: 1; }
    50% { opacity: 0; }
    75% { margin-top: @dropzone-size; opacity: 0; }
    to { margin-top: @dropzone-size; opacity: 0; }
  }
  @keyframes caretleft {
    from { margin-right: 0; opacity: 1; }
    50% { opacity: 0; }
    75% { margin-right: @dropzone-size; opacity: 0; }
    to { margin-right: @dropzone-size; opacity: 0; }
  }
  @keyframes caretright {
    from { margin-left: 0; opacity: 1; }
    50% { opacity: 0; }
    75% { margin-left: @dropzone-size; opacity: 0; }
    to { margin-left: @dropzone-size; opacity: 0; }
  }

  div.dropzone {
    position: absolute;
    background-color: rgba(0, 0, 0, 0);
    transition: all 0.3s ease;
    // Display the direction caret centered ...
    display: flex;
    align-items: center;
    // ... and in white (against the dragover background color)
    color: white;

    cds-icon { margin: 0; }

    &.dragover {
      background-color: rgba(21, 61, 107, 0.5);
      box-shadow: 0px 0px 5px 0px rgba(0, 0, 0, .2);
      backdrop-filter: blur(2px);
    }

    &.top {
      top: 0;
      width: 100%;
      height: @dropzone-size;
      flex-direction: column-reverse;
      cds-icon { animation: 1s ease-out infinite running caretup; }
    }

    &.left {
      top: 0;
      left: 0;
      height: 100%;
      width: @dropzone-size;
      flex-direction: row-reverse;
      cds-icon { animation: 1s ease-out infinite running caretleft; }
    }

    &.right {
      top: 0;
      right: 0;
      height: 100%;
      width: @dropzone-size;
      flex-direction: row;
      cds-icon { animation: 1s ease-out infinite running caretright; }
    }

    &.bottom {
      bottom: 0;
      width: 100%;
      height: @dropzone-size;
      justify-content: center;
      align-items: flex-start;
      cds-icon { animation: 1s ease-out infinite running caretdown; }
    }
  }

  .cm-editor {
    .cm-scroller { padding: 50px 50px; }

    .code { // BEGIN: CODE BLOCK/FILE THEME
      // We're using this solarized theme here: https://ethanschoonover.com/solarized/
      // See also the CodeEditor.vue component, which uses the same colours
      @base03:    #002b36;
      @base02:    #073642;
      @base01:    #586e75;
      @base00:    #657b83;
      @base0:     #839496;
      @base1:     #93a1a1;
      @base2:     #eee8d5;
      @base3:     #fdf6e3;
      @yellow:    #b58900;
      @orange:    #cb4b16;
      @red:       #dc322f;
      @magenta:   #d33682;
      @violet:    #6c71c4;
      @blue:      #268bd2;
      @cyan:      #2aa198;
      @green:     #859900;

      color: @base01;
      font-family: 'Inconsolata', Consolas, Menlo, monospace;

      .cm-string     { color: @green; }
      .cm-keyword    { color: @green; }
      .cm-atom       { color: @violet; }
      .cm-tag-name, .cm-modifier { color: @cyan; }
      .cm-qualifier  { color: @blue; }
      .cm-builtin    { color: @blue; }
      .cm-variable-name { color: @cyan; }
      .cm-variable   { color: @cyan; }
      .cm-comment    { color: @base1; }
      .cm-attribute-name  { color: @orange; }
      .cm-property   { color: @magenta; }
      .cm-keyword,
      .cm-name,
      .cm-type-name       { color: @yellow; }
      .cm-number     { color: @violet; }
      .cm-property-name { color: @blue; }

      .cm-positive { color: @green; }
      .cm-negative { color: @red; }
    } // END: Solarized code theme
  }

  // If a code file is loaded, we need to display the editor contents in monospace.
  &.code-file .cm-editor {
    font-family: 'Inconsolata', Consolas, Menlo, monospace;

    // Reset the margins for code files
    .cm-scroller { padding: 0px; }
  }

  .cm-content {
    overflow-x: hidden !important; // Necessary to hide the horizontal scrollbar
  }
}

body.dark .main-editor-wrapper {
  background-color: rgba(20, 20, 30, 1);
  .CodeMirror .CodeMirror-gutters { background-color: rgba(20, 20, 30, 1); }
}

// Account for the tabbar
.main-editor-wrapper:not(.fullscreen) {
  height: calc(100% - 30px);
}

// CodeMirror fullscreen
.main-editor-wrapper.fullscreen {
  .cm-scroller {
    @media(min-width: 1301px) { padding: 0 @editor-margin-fullscreen-xxl; }
    @media(max-width: 1300px) { padding: 0 @editor-margin-fullscreen-xl; }
    @media(max-width: 1100px) { padding: 0 @editor-margin-fullscreen-lg; }
    @media(max-width: 1000px) { padding: 0 @editor-margin-fullscreen-md; }
    @media(max-width:  800px) { padding: 0 @editor-margin-fullscreen-sm; }

  }
}

// Ensure the editor ALWAYS stays below the menubar
// On macOS, we have the traffic lights, therefore we can literally make the
// editor take the full space of the window in distraction free
body.win32 .main-editor-wrapper.fullscreen { top: 30px; }
// TODO: Interferes on Linux with whether we have a menubar or not!
body.linux .main-editor-wrapper.fullscreen { top: 41px; }

body.darwin {
    .main-editor-wrapper.fullscreen {
     border-top: 1px solid #d5d5d5;
  }

  &.dark {
    .main-editor-wrapper.fullscreen {
      border-top-color: #505050;
    }
  }
}

</style>
