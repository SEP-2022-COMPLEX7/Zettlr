<template>
  <div class="tree-item-container">
    <div
      v-bind:class="{
        'tree-item': true,
        [obj.type]: true,
        'selected': isSelected,
        'active': activeItem === obj.path,
        'project': obj.type === 'directory' && obj.settings.project != null,
        'root': isRoot
      }"
      v-bind:data-id="obj.type === 'file' ? obj.id : ''"
      v-bind:style="{
        'padding-left': `${depth * 15 + 10}px`
      }"
      v-on:click.stop="requestSelection"
      v-on:auxclick.stop="requestSelection"
      v-on:contextmenu="handleContextMenu"
      v-on:dragover="acceptDrags"
      v-on:dragenter="enterDragging"
      v-on:dragleave="leaveDragging"
      v-on:drop="handleDrop"
    >
      <!-- First: Secondary icon (only if primaryIcon displays the chevron) -->
      <span class="item-icon" aria-hidden="true">
        <cds-icon
          v-if="secondaryIcon !== false"
          v-bind:shape="secondaryIcon"
          role="presentation"
          v-bind:class="{
            'is-solid': typeof secondaryIcon !== 'boolean' && [ 'disconnect', 'blocks-group' ].includes(secondaryIcon),
            'special': typeof secondaryIcon !== 'boolean'
          }"
        />
      </span>
      <!-- Second: Primary icon (either the chevron, or the custom icon) -->
      <span class="toggle-icon" aria-hidden="true">
        <!-- If the customIcon is set to 'writing-target' we need to display our
        custom progress ring, instead of a regular icon -->
        <RingProgress
          v-if="primaryIcon === 'writing-target'"
          v-bind:ratio="writingTargetPercent"
        ></RingProgress>
        <!-- Otherwise, display whatever the secondary Icon is -->
        <cds-icon
          v-else-if="primaryIcon !== false"
          v-bind:shape="primaryIcon"
          role="presentation"
          v-bind:class="{
            'special': typeof primaryIcon !== 'boolean' && ![ 'right', 'down' ].includes(primaryIcon)
          }"
          v-bind:direction="angleDirection"
          v-bind:solid="typeof primaryIcon !== 'boolean' && [ 'disconnect', 'blocks-group' ].includes(primaryIcon)"
          v-on:click.stop="handlePrimaryIconClick"
          v-on:auxclick.stop.prevent="handlePrimaryIconClick"
        ></cds-icon>
      </span>
      <span
        ref="display-text"
        v-bind:class="{
          'display-text': true,
          'highlight': canAcceptDraggable
        }"
        role="button"
        v-bind:aria-label="`Select ${obj.name}`"
        v-bind:draggable="!isRoot"
        v-bind:title="obj.path"
        v-on:dragstart="beginDragging"
        v-on:drag="onDragHandler"
      >
        <template v-if="!nameEditing">
          {{ basename }}
        </template>
        <template v-else>
          <input
            ref="name-editing-input"
            type="text"
            v-bind:value="obj.name"
            v-on:keyup.enter="finishNameEditing(($event.target as HTMLInputElement).value)"
            v-on:keyup.esc="nameEditing = false"
            v-on:keydown.stop=""
            v-on:blur="nameEditing = false"
            v-on:click.stop=""
          >
        </template>
        <span
          v-if="hasDuplicateName"
          class="dir"
        >
          &nbsp;({{ dirname }})
        </span>
      </span>
    </div>
    <div
      v-if="operationType !== undefined"
      v-bind:style="{
        'padding-left': `${(depth + 2) * 15 + 10}px`
      }"
    >
      <input
        v-if="operationType !== undefined"
        ref="new-object-input"
        type="text"
        v-on:keyup.enter="handleOperationFinish(($event.target as HTMLInputElement).value)"
        v-on:keyup.esc="operationType = undefined"
        v-on:keydown.stop=""
        v-on:blur="operationType = undefined"
        v-on:click.stop=""
      >
    </div>
    <div v-if="isDirectory && !shouldBeCollapsed">
      <TreeItem
        v-for="child in filteredChildren"
        v-bind:key="child.path"
        v-bind:obj="child"
        v-bind:is-currently-filtering="isCurrentlyFiltering"
        v-bind:depth="depth + 1"
        v-bind:active-item="activeItem"
        v-bind:window-id="windowId"
      >
      </TreeItem>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TreeItem Vue Component
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Controls a single sub-tree in the file manager.
 *
 * END HEADER
 */

import itemMixin from './util/item-mixin'
import generateFilename from '@common/util/generate-filename'
import { trans } from '@common/i18n-renderer'

import RingProgress from '@common/vue/window/toolbar-controls/RingProgress.vue'
import { nextTick, defineComponent } from 'vue'
import { DirDescriptor, MaybeRootDescriptor } from '@dts/common/fsal'

const path = window.path
const ipcRenderer = window.ipc

export default defineComponent({
  name: 'TreeItem',
  components: { RingProgress },
  mixins: [itemMixin],
  props: {
    // How deep is this tree item nested?
    depth: {
      type: Number,
      default: 0
    },
    hasDuplicateName: {
      type: Boolean,
      default: false // Can only be true if root and actually has a duplicate name
    },
    obj: {
      type: Object as () => MaybeRootDescriptor,
      required: true
    },
    isCurrentlyFiltering: {
      type: Boolean,
      default: false
    },
    activeItem: {
      type: String,
      default: undefined
    },
    windowId: {
      type: String,
      required: true
    }
  },
  data: () => {
    return {
      collapsed: true, // Initial: collapsed list (if there are children)
      operationType: undefined, // Can be createFile or createDir
      canAcceptDraggable: false, // Helper var set to true while something hovers over this element
      uncollapseTimeout: undefined as undefined|ReturnType<typeof setTimeout> // Used to uncollapse directories during drag&drop ops
    }
  },
  computed: {
    shouldBeCollapsed: function (): boolean {
      if (this.isCurrentlyFiltering) {
        // If the application is currently running a filter, uncollapse everything
        return false
      } else {
        // Else, just uncollapse if the user wishes so
        return this.$store.state.uncollapsedDirectories.includes(this.obj.path) === false
      }
    },
    /**
     * The secondary icon's shape -- this is the visually FIRST icon to be displayed
     *
     * @return  {string|boolean}  False if no secondary icon
     */
    secondaryIcon: function (): string|boolean {
      if (!this.hasChildren) {
        // If whatever the object we're representing has no children, we do not
        // need the secondary icon, since the primary icon will display whatever
        // is necessary.
        return false
      } else {
        // Otherwise, the primaryIcon will display the chevron and we need to
        // transfer the customIcon to this position.
        return this.customIcon
      }
    },
    /**
     * The primary icon's shape -- this is the visually SECOND icon to be displayed
     *
     * @return  {string|boolean}  False if no primary icon
     */
    primaryIcon: function (): string|boolean {
      // The primary icon is _always_ the chevron if we're dealing with a
      // directory and it has children. Otherwise, it will display the custom icon.
      return this.hasChildren ? 'angle' : this.customIcon
    },
    angleDirection: function (): string|undefined {
      if (!this.hasChildren) {
        return undefined
      } else {
        return this.shouldBeCollapsed ? 'right' : 'down'
      }
    },
    /**
     * Returns an icon appropriate to the item we are representing, or false if
     * there is no icon available.
     *
     * @return  {string|boolean}  False if no custom icon.
     */
    customIcon: function (): string|boolean {
      if (this.obj.type === 'file' && this.writingTarget !== undefined) {
        return 'writing-target'
      } else if (this.obj.type === 'file') {
        return 'file'
      } else if (this.obj.type === 'code') {
        return 'code'
      } else if (this.obj.dirNotFoundFlag === true) {
        return 'disconnect'
      } else if (this.obj.settings.project !== null) {
        // Indicate that this directory has a project.
        return 'blocks-group'
      } else if (this.obj.settings.icon != null) {
        // Display the custom icon
        return this.obj.settings.icon
      }

      // No icon available
      return false
    },
    writingTarget: function (): undefined|{ path: string, mode: 'words'|'chars', count: number } {
      if (this.obj.type !== 'file') {
        return undefined
      } else {
        return this.$store.state.writingTargets.find((x: any) => x.path === this.obj.path)
      }
    },
    writingTargetPercent: function (): number {
      if (this.writingTarget !== undefined && this.obj.type === 'file') {
        const count = this.writingTarget.mode === 'words'
          ? this.obj.wordCount
          : this.obj.charCount

        let ratio = count / this.writingTarget.count
        return Math.min(1, ratio)
      } else {
        return 0.0
      }
    },
    /**
     * Returns true if this item is a root item
     */
    isRoot: function (): boolean {
      return this.obj.root
    },
    /**
     * Returns true if the file manager mode is set to "combined"
     */
    combined: function (): boolean {
      return this.$store.state.config.fileManagerMode === 'combined'
    },
    /**
     * Returns true if there are children that can be displayed
     *
     * @return {boolean} Whether or not this object has children.
     */
    hasChildren: function (): boolean {
      // Return true if it's a directory, with at least one directory as children
      if (this.obj.type !== 'directory') {
        return false
      }

      return this.isDirectory === true && this.filteredChildren.length > 0
    },
    /**
     * Returns the (containing) directory name.
     */
    dirname: function (): string {
      return path.basename(this.obj.dir)
    },
    /**
     * Returns a list of children that can be displayed inside the tree view
     */
    filteredChildren: function (): MaybeRootDescriptor[] {
      if (this.obj.type !== 'directory') {
        return []
      }
      if (this.combined === true) {
        return this.obj.children.filter(child => child.type !== 'other') as MaybeRootDescriptor[]
      } else {
        return this.obj.children.filter(child => child.type === 'directory') as DirDescriptor[]
      }
    },
    useH1: function (): boolean {
      return this.$store.state.config.fileNameDisplay.includes('heading')
    },
    useTitle: function (): boolean {
      return this.$store.state.config.fileNameDisplay.includes('title')
    },
    displayMdExtensions: function (): boolean {
      return this.$store.state.config['display.markdownFileExtensions']
    },
    basename: function (): string {
      if (this.obj.type !== 'file') {
        return this.obj.name
      }

      if (this.useTitle && this.obj.yamlTitle !== undefined) {
        return this.obj.yamlTitle
      } else if (this.useH1 && this.obj.firstHeading !== null) {
        return this.obj.firstHeading
      } else if (this.displayMdExtensions) {
        return this.obj.name
      } else {
        return this.obj.name.replace(this.obj.ext, '')
      }
    },
    isSelected: function (): boolean {
      if (this.obj.type === 'directory') {
        if (this.selectedDir === null) {
          return false
        }
        return this.selectedDir.path === this.obj.path
      } else {
        if (this.selectedFile === null) {
          return false
        }
        return this.selectedFile.path === this.obj.path
      }
    }
  },
  watch: {
    selectedFile: function (newVal, oldVal) {
      this.uncollapseIfApplicable()
    },
    collapsed: function () {
      if (this.collapsed) {
        this.$store.commit('removeUncollapsedDirectory', this.obj.path)
      } else {
        this.$store.commit('addUncollapsedDirectory', this.obj.path)
      }
    },
    selectedDir: function (newVal, oldVal) {
      // this.uncollapseIfApplicable() TODO: As of now this would also uncollapse the containing file's directory
    },
    operationType: function (newVal, oldVal) {
      if (newVal !== undefined) {
        nextTick().then(() => {
          const input = this.$refs['new-object-input'] as HTMLInputElement
          if (this.operationType === 'createFile') {
            // If we're generating a file, generate a filename
            const filenamePattern = this.$store.state.config.newFileNamePattern
            const idGenPattern = this.$store.state.config['zkn.idGen']
            input.value = generateFilename(filenamePattern, idGenPattern)
          } else if (this.operationType === 'createDir') {
            // Else standard val for new dirs.
            input.value = trans('Untitled')
          }
          input.focus()
          // Select from the beginning until the last dot
          input.setSelectionRange(0, input.value.lastIndexOf('.'))
        })
          .catch(err => console.error(err))
      }
    }
  },
  mounted: function () {
    this.uncollapseIfApplicable()
  },
  methods: {
    uncollapseIfApplicable: function () {
      const filePath = (this.selectedFile !== null) ? String(this.selectedFile.path) : ''
      const dirPath = (this.selectedDir !== null) ? String(this.selectedDir.path) : ''

      // Open the tree, if the selected file is contained in this dir somewhere
      if (filePath.startsWith(this.obj.path)) {
        this.collapsed = false
      } else {
        // we are not in the filepath of the currently open note, do not change the state!
        return
      }

      // If a directory within this has been selected, open up, lads!
      if ((this.obj.path as string).startsWith(dirPath)) {
        this.collapsed = false
      }
    },
    /**
     * Initiates a drag movement and inserts the correct data
     * @param {DragEvent} event The drag event
     */
    beginDragging: function (event: DragEvent) {
      if (event.dataTransfer === null) {
        return
      }

      event.dataTransfer.dropEffect = 'move'
      event.dataTransfer.setData('text/x-zettlr-file', JSON.stringify({
        type: this.obj.type,
        path: this.obj.path,
        id: (this.obj.type === 'file') ? this.obj.id : ''
      }))
    },
    /**
     * Called when a drag operation enters this item; adds a highlight class
     */
    enterDragging: function (event: DragEvent) {
      if (this.isDirectory === false) {
        return
      }

      this.canAcceptDraggable = true

      if (this.collapsed === false) {
        return
      }

      this.uncollapseTimeout = setTimeout(() => {
        this.collapsed = false
        this.uncollapseTimeout = undefined
      }, 2000)
    },
    /**
     * The oppossite of enterDragging; removes the highlight class
     */
    leaveDragging: function (event: DragEvent) {
      if (this.isDirectory === false) {
        return
      }

      this.canAcceptDraggable = false

      if (this.uncollapseTimeout !== undefined) {
        clearTimeout(this.uncollapseTimeout)
        this.uncollapseTimeout = undefined
      }
    },
    /**
     * Called whenever something is dropped onto the element.
     * Only executes if it's a valid tree-item/file-list object.
     */
    handleDrop: function (event: DragEvent) {
      this.canAcceptDraggable = false
      event.preventDefault()

      if (this.isDirectory === false) {
        return
      }

      if (this.uncollapseTimeout !== undefined) {
        clearTimeout(this.uncollapseTimeout)
        this.uncollapseTimeout = undefined
      }

      if (event.dataTransfer === null) {
        return
      }

      // Now we have to be careful. The user can now ALSO
      // drag and drop files right onto the list. So we need
      // to make sure it's really an element from in here and
      // NOT a file, because these need to be handled by the
      // app itself.
      let data

      try {
        const eventData = event.dataTransfer.getData('text/x-zettlr-file')
        data = JSON.parse(eventData) // Throws error if eventData === ''
      } catch (err) {
        // Error in JSON stringifying (either b/c malformed or no text)
        return
      }

      // The user dropped the file onto itself
      if (data.path === this.obj.path) {
        return
      }

      // Finally, request the move!
      ipcRenderer.invoke('application', {
        command: 'request-move',
        payload: {
          from: data.path,
          to: this.obj.path
        }
      })
        .catch(err => console.error(err))
    },
    /**
     * Makes sure the browser doesn't do unexpected stuff when dragging, e.g., external files.
     * @param {DragEvent} event The drag event
     */
    acceptDrags: function (event: DragEvent) {
      // We need to constantly preventDefault to ensure
      // that, e.g., a Python or other script file doesn't
      // override the location.href to display.
      event.preventDefault()
    },
    handleOperationFinish: function (newName: string) {
      if (this.operationType === 'createFile' && newName.trim() !== '') {
        ipcRenderer.invoke('application', {
          command: 'file-new',
          payload: {
            path: this.obj.path,
            name: newName.trim()
          }
        }).catch(e => console.error(e))
      } else if (this.operationType === 'createDir' && newName.trim() !== '') {
        ipcRenderer.invoke('application', {
          command: 'dir-new',
          payload: {
            path: this.obj.path,
            name: newName.trim()
          }
        }).catch(e => console.error(e))
      }

      this.operationType = undefined
    },
    handlePrimaryIconClick: function () {
      if (this.hasChildren === true) {
        this.collapsed = this.collapsed === false
      }
    }
  }
})
</script>

<style lang="less">
body {
  div.tree-item-container {
    .tree-item {
      white-space: nowrap;
      display: flex;

      .item-icon, .toggle-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        flex-shrink: 0; // Prevent shrinking; only the display text should
      }

      .display-text {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      // These inputs should be more or less "invisible"
      input {
        border: none;
        color: inherit;
        font-family: inherit;
        font-size: inherit;
        background-color: transparent;
        padding: 0;
      }

      &.project {
        color: rgb(220, 45, 45);
      }

      &.selected .display-text {
        background-color: var(--system-accent-color, --c-primary);
        color: var(--system-accent-color-contrast, --c-primary-contrast);
      }

      &.active .display-text {
        background-color: rgb(68, 68, 68);
        color: rgb(255, 255, 255);
      }
    }
  }

  &.dark div.tree-item-container {
    .tree-item {
      &.project {
        color: rgb(240, 98, 98);
      }

      &.active .display-text {
        background-color: rgb(68, 68, 68);
        color: rgb(255, 255, 255);
      }
    }
  }
}

body.darwin {
  .tree-item {
    margin: 6px 0px;
    color: rgb(53, 53, 53);

    // On macOS, non-standard icons are normally displayed in color
    clr-icon.special { color: var(--system-accent-color, --c-primary); }

    .display-text {
      font-size: 13px;
      padding: 3px 5px;
      border-radius: 4px;
      overflow: hidden;

      &.highlight {
        outline-width: 2px;
        outline-color: var(--system-accent-color, --c-primary);
        outline-style: solid;
      }
    }

    &.selected .display-text {
      background-image: linear-gradient(#00000000, #00000022);
    }
  }

  &.dark {
    .tree-item {
      color: rgb(240, 240, 240);
    }
  }
}

body.win32 {
  .tree-item {
    margin: 8px 0px;

    .display-text {
      font-size: 13px;
      padding: 3px 5px;
      overflow: hidden;

      &.highlight {
        // This class is applied on drag & drop
        background-color: var(--system-accent-color, --c-primary);
        color: var(--system-accent-color-contrast, --c-primary-contrast);
      }
    }
  }
}

body.linux {
  .tree-item {
    margin: 8px 0px;

    .display-text {
      font-size: 13px;
      padding: 3px 5px;
      overflow: hidden;

      &.highlight {
        // This class is applied on drag & drop
        background-color: var(--system-accent-color, --c-primary);
        color: var(--system-accent-color-contrast, --c-primary-contrast);
      }
    }
  }
}
</style>
