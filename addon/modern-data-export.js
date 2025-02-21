import { sfConn, apiVersion } from "./inspector.js";

class QueryBuilder {
  constructor() {
    this.blocks = [];
    this.conditions = [];
    this.selectedObject = null;
    this.selectedFields = new Set();
    this.orderBy = [];
    this.limit = null;
    this.groupOperator = "AND"; // Default operator for condition groups
  }

  addBlock(type, config) {
    this.blocks.push({ type, config, id: Date.now() });
  }

  removeBlock(id) {
    this.blocks = this.blocks.filter(block => block.id !== id);
  }

  buildQuery() {
    let query = "SELECT ";
    
    // Add selected fields
    if (this.selectedFields.size === 0) {
      query += "Id";
    } else {
      query += Array.from(this.selectedFields).join(", ");
    }
    
    // Add FROM clause
    if (this.selectedObject) {
      query += ` FROM ${this.selectedObject}`;
    }
    
    // Add WHERE conditions with groups
    if (this.conditions.length > 0) {
      query += " WHERE ";
      
      const groupedConditions = this.conditions.reduce((acc, condition) => {
        const groupId = condition.groupId || 'default';
        if (!acc[groupId]) {
          acc[groupId] = [];
        }
        acc[groupId].push(condition);
        return acc;
      }, {});

      const groupStrings = Object.entries(groupedConditions).map(([groupId, conditions]) => {
        const conditionString = conditions
          .map(condition => `${condition.field} ${condition.operator} ${this.formatValue(condition.value, condition.type)}`)
          .join(` ${this.groupOperator} `);
        
        return conditions.length > 1 ? `(${conditionString})` : conditionString;
      });

      query += groupStrings.join(` ${this.groupOperator} `);
    }
    
    // Add ORDER BY
    if (this.orderBy.length > 0) {
      query += " ORDER BY " + this.orderBy
        .map(o => `${o.field} ${o.direction}`)
        .join(", ");
    }
    
    // Add LIMIT
    if (this.limit) {
      query += ` LIMIT ${this.limit}`;
    }
    
    return query;
  }

  formatValue(value, type) {
    switch (type) {
      case "string":
      case "textarea":
      case "url":
      case "email":
      case "phone":
        return `'${value.replace(/'/g, "\\'")}'`;
      case "boolean":
        return value;
      case "date":
        return value.includes("'") ? value : `'${value}'`;
      case "datetime":
        return value.includes("'") ? value : `${value}`;
      case "number":
      case "currency":
      case "percent":
        return value;
      default:
        return `'${value.replace(/'/g, "\\'")}'`;
    }
  }
}

class QueryTemplates {
  static templates = {
    "Recently Modified": {
      name: "Recently Modified Records",
      query: "SELECT Id, Name, LastModifiedDate FROM {object} ORDER BY LastModifiedDate DESC LIMIT 100"
    },
    "Created This Week": {
      name: "Records Created This Week",
      query: "SELECT Id, Name, CreatedDate FROM {object} WHERE CreatedDate = THIS_WEEK ORDER BY CreatedDate DESC"
    },
    "Modified By Me": {
      name: "Records I Modified",
      query: "SELECT Id, Name, LastModifiedDate FROM {object} WHERE LastModifiedById = {userId} ORDER BY LastModifiedDate DESC"
    },
    "Duplicate Check": {
      name: "Potential Duplicates",
      query: "SELECT Name, COUNT(Id) records FROM {object} GROUP BY Name HAVING COUNT(Id) > 1"
    }
  };

  static getTemplateQuery(templateId, object, userId) {
    const template = this.templates[templateId];
    if (!template) return null;
    
    return template.query
      .replace(/{object}/g, object)
      .replace(/{userId}/g, userId);
  }
}

class SavedQueries {
  constructor(storageKey = "modernExportSavedQueries") {
    this.storageKey = storageKey;
  }

  save(query) {
    const saved = this.getAll();
    saved.unshift({
      id: Date.now(),
      ...query,
      timestamp: new Date().toISOString()
    });
    localStorage.setItem(this.storageKey, JSON.stringify(saved));
  }

  getAll() {
    try {
      return JSON.parse(localStorage.getItem(this.storageKey)) || [];
    } catch {
      return [];
    }
  }

  delete(id) {
    const saved = this.getAll().filter(q => q.id !== id);
    localStorage.setItem(this.storageKey, JSON.stringify(saved));
  }
}

class QueryHistory {
  constructor(storageKey = "modernExportQueryHistory", maxSize = 50) {
    this.storageKey = storageKey;
    this.maxSize = maxSize;
  }

  add(query) {
    const history = this.getAll();
    history.unshift({
      query,
      timestamp: new Date().toISOString()
    });
    
    if (history.length > this.maxSize) {
      history.pop();
    }
    
    localStorage.setItem(this.storageKey, JSON.stringify(history));
  }

  getAll() {
    try {
      return JSON.parse(localStorage.getItem(this.storageKey)) || [];
    } catch {
      return [];
    }
  }

  clear() {
    localStorage.removeItem(this.storageKey);
  }
}

class QueryOptimizer {
  static analyzeQuery(query, objectMetadata, fieldMetadata) {
    const suggestions = [];
    
    // Check for SELECT *
    if (query.match(/SELECT\s+\*/i)) {
      suggestions.push({
        type: 'performance',
        severity: 'warning',
        message: 'Specify only needed fields instead of SELECT *',
        fix: 'Select specific fields'
      });
    }

    // Check for missing WHERE clause
    if (!query.match(/WHERE/i) && !query.match(/LIMIT/i)) {
      suggestions.push({
        type: 'performance',
        severity: 'warning',
        message: 'Query might return too many records',
        fix: 'Add WHERE clause or LIMIT'
      });
    }

    // Check for indexed fields in WHERE clause
    const whereMatch = query.match(/WHERE\s+(.*?)(?:\s+ORDER BY|\s+LIMIT|$)/i);
    if (whereMatch && fieldMetadata) {
      const whereClause = whereMatch[1];
      const usedFields = whereClause.match(/\w+\.\w+|\w+/g) || [];
      
      usedFields.forEach(field => {
        const fieldInfo = fieldMetadata.find(f => f.name === field);
        if (fieldInfo && !fieldInfo.indexed) {
          suggestions.push({
            type: 'performance',
            severity: 'info',
            message: `Field "${field}" is not indexed`,
            fix: 'Consider using indexed fields in filters'
          });
        }
      });
    }

    // Check for ORDER BY on large result sets
    if (query.match(/ORDER BY/i) && !query.match(/LIMIT/i)) {
      suggestions.push({
        type: 'performance',
        severity: 'info',
        message: 'ORDER BY without LIMIT might be slow',
        fix: 'Add LIMIT clause'
      });
    }

    return suggestions;
  }
}

class UndoManager {
  constructor(maxHistory = 50) {
    this.history = [];
    this.currentIndex = -1;
    this.maxHistory = maxHistory;
  }

  pushState(state) {
    // Remove any future states if we're in the middle of the history
    if (this.currentIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.currentIndex + 1);
    }

    // Add new state
    this.history.push(JSON.parse(JSON.stringify(state)));
    
    // Remove oldest states if we exceed maxHistory
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    } else {
      this.currentIndex++;
    }
  }

  undo() {
    if (this.canUndo()) {
      this.currentIndex--;
      return JSON.parse(JSON.stringify(this.history[this.currentIndex]));
    }
    return null;
  }

  redo() {
    if (this.canRedo()) {
      this.currentIndex++;
      return JSON.parse(JSON.stringify(this.history[this.currentIndex]));
    }
    return null;
  }

  canUndo() {
    return this.currentIndex > 0;
  }

  canRedo() {
    return this.currentIndex < this.history.length - 1;
  }

  clear() {
    this.history = [];
    this.currentIndex = -1;
  }
}

class ModernExportModel {
  constructor(sfHost) {
    this.sfHost = sfHost;
    this.queryBuilder = new QueryBuilder();
    this.results = null;
    this.isLoading = false;
    this.error = null;
    this.objectMetadata = null;
    this.reactCallback = null;
    this.fieldMetadata = null;
    this.savedQueries = new SavedQueries();
    this.queryHistory = new QueryHistory();
    this.undoManager = new UndoManager();
    this.suggestions = [];
    this.initKeyboardShortcuts();
  }

  initKeyboardShortcuts() {
    document.addEventListener('keydown', e => {
      // Execute query: Ctrl/Cmd + Enter
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        const query = this.queryBuilder.buildQuery();
        this.executeQuery(query);
      }

      // Save query: Ctrl/Cmd + S
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        this.saveCurrentQuery();
      }

      // Clear form: Ctrl/Cmd + L
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        this.clearForm();
      }

      // Undo: Ctrl/Cmd + Z
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      }

      // Redo: Ctrl/Cmd + Shift + Z or Ctrl/Cmd + Y
      if ((e.ctrlKey || e.metaKey) && (
        (e.key === 'z' && e.shiftKey) ||
        e.key === 'y'
      )) {
        e.preventDefault();
        this.redo();
      }
    });
  }

  saveCurrentQuery() {
    const query = {
      name: `Query ${new Date().toLocaleString()}`,
      query: this.queryBuilder.buildQuery(),
      object: this.queryBuilder.selectedObject
    };
    this.savedQueries.save(query);
    this.didUpdate();
  }

  clearForm() {
    this.queryBuilder = new QueryBuilder();
    this.results = null;
    this.error = null;
    this.didUpdate();
  }

  async loadObjectMetadata() {
    try {
      this.isLoading = true;
      this.error = null;
      const response = await sfConn.rest("/services/data/v" + apiVersion + "/sobjects/");
      this.objectMetadata = response.sobjects;
    } catch (error) {
      this.error = error.message;
    } finally {
      this.isLoading = false;
      this.didUpdate();
    }
  }

  async executeQuery(query) {
    try {
      this.isLoading = true;
      this.error = null;
      const response = await sfConn.rest("/services/data/v" + apiVersion + "/query/?q=" + encodeURIComponent(query));
      this.results = response;
    } catch (error) {
      this.error = error.message;
    } finally {
      this.isLoading = false;
      this.didUpdate();
    }
  }

  async loadFieldMetadata(objectName) {
    try {
      this.isLoading = true;
      this.error = null;
      this.didUpdate();

      const response = await sfConn.rest(`/services/data/v${apiVersion}/sobjects/${objectName}/describe`);
      this.fieldMetadata = response.fields;
    } catch (error) {
      this.error = error.message;
    } finally {
      this.isLoading = false;
      this.didUpdate();
    }
  }

  didUpdate(cb) {
    if (this.reactCallback) {
      this.reactCallback(cb);
    }
  }

  saveState() {
    const state = {
      queryBuilder: this.queryBuilder,
      results: this.results
    };
    this.undoManager.pushState(state);
  }

  undo() {
    const state = this.undoManager.undo();
    if (state) {
      this.queryBuilder = state.queryBuilder;
      this.results = state.results;
      this.didUpdate();
    }
  }

  redo() {
    const state = this.undoManager.redo();
    if (state) {
      this.queryBuilder = state.queryBuilder;
      this.results = state.results;
      this.didUpdate();
    }
  }

  updateSuggestions() {
    const query = this.queryBuilder.buildQuery();
    this.suggestions = QueryOptimizer.analyzeQuery(
      query,
      this.objectMetadata,
      this.fieldMetadata
    );
    this.didUpdate();
  }

  async executeBatchOperation(operation, recordIds, fieldValues) {
    try {
      this.isLoading = true;
      this.error = null;

      if (operation === 'delete') {
        await Promise.all(recordIds.map(id =>
          sfConn.rest(`/services/data/v${apiVersion}/sobjects/${this.queryBuilder.selectedObject}/${id}`, {
            method: 'DELETE'
          })
        ));
      } else if (operation === 'update') {
        await Promise.all(recordIds.map(id =>
          sfConn.rest(`/services/data/v${apiVersion}/sobjects/${this.queryBuilder.selectedObject}/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(fieldValues)
          })
        ));
      }

      // Refresh results
      const query = this.queryBuilder.buildQuery();
      await this.executeQuery(query);
    } catch (error) {
      this.error = error.message;
    } finally {
      this.isLoading = false;
      this.didUpdate();
    }
  }
}

// React Components
const h = React.createElement;

class ObjectSelector extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      searchTerm: "",
      showDropdown: false
    };
  }

  getFilteredObjects() {
    const { objects } = this.props;
    const { searchTerm } = this.state;
    
    return objects?.filter(obj => 
      !searchTerm || 
      obj.label.toLowerCase().includes(searchTerm.toLowerCase()) ||
      obj.name.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }

  render() {
    const { selectedObject, onSelect, onObjectSelect } = this.props;
    const { searchTerm, showDropdown } = this.state;
    const filteredObjects = this.getFilteredObjects();
    
    return h("div", { className: "object-selector" },
      h("div", { className: "field-selector-controls" },
        h("input", {
          type: "text",
          className: "field-search",
          placeholder: "Search objects...",
          value: searchTerm,
          onChange: e => this.setState({ searchTerm: e.target.value }),
          onFocus: () => this.setState({ showDropdown: true })
        })
      ),
      showDropdown && h("div", { className: "field-list" },
        filteredObjects?.map(obj => 
          h("div", {
            key: obj.name,
            className: "field-item" + (selectedObject === obj.name ? " selected" : ""),
            onClick: () => {
              onSelect(obj.name);
              if (obj.name) {
                onObjectSelect(obj.name);
              }
              this.setState({ showDropdown: false });
            }
          },
            h("div", { className: "field-item-header" },
              h("span", { className: "field-item-label" }, obj.label)
            ),
            h("div", { className: "field-item-name" }, obj.name)
          )
        )
      )
    );
  }
}

class FieldSelector extends React.Component {
  render() {
    // Field selection UI
    return h("div", { className: "field-selector" });
  }
}

class DraggableBlock extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      isDragging: false
    };
    this.dragStart = this.dragStart.bind(this);
    this.dragEnd = this.dragEnd.bind(this);
  }

  dragStart(e) {
    e.dataTransfer.setData('blockType', this.props.type);
    this.setState({ isDragging: true });
  }

  dragEnd() {
    this.setState({ isDragging: false });
  }

  render() {
    const { type, children } = this.props;
    const { isDragging } = this.state;

    return h("div", {
      className: `query-block ${isDragging ? 'dragging' : ''}`,
      draggable: true,
      onDragStart: this.dragStart,
      onDragEnd: this.dragEnd,
      "data-type": type
    }, children);
  }
}

class FieldBlock extends React.Component {
  render() {
    const { field, onRemove } = this.props;
    
    return h("div", { className: "field-block" },
      h("div", { className: "field-block-header" },
        h("span", { className: "field-name" }, field.label),
        h("button", { 
          className: "remove-field",
          onClick: onRemove
        }, "×")
      ),
      h("div", { className: "field-block-content" },
        h("span", { className: "field-api-name" }, field.name),
        h("span", { className: "field-type" }, field.type)
      )
    );
  }
}

class ConditionGroup extends React.Component {
  render() {
    const { conditions, operator, onOperatorChange, onRemove } = this.props;

    return h("div", { className: "condition-group" },
      h("div", { className: "condition-group-header" },
        h("select", {
          value: operator,
          onChange: e => onOperatorChange(e.target.value),
          className: "group-operator"
        },
          h("option", { value: "AND" }, "AND"),
          h("option", { value: "OR" }, "OR")
        ),
        h("button", {
          className: "remove-group",
          onClick: onRemove
        }, "×")
      ),
      h("div", { className: "condition-group-content" },
        conditions
      )
    );
  }
}

class ConditionBlock extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      operator: "=",
      value: "",
      showFieldSelector: false
    };
  }

  getOperatorsForType(fieldType) {
    const commonOperators = [
      { value: "=", label: "equals" },
      { value: "!=", label: "not equals" }
    ];

    switch (fieldType) {
      case "string":
      case "textarea":
      case "url":
      case "email":
      case "phone":
        return [
          ...commonOperators,
          { value: "LIKE", label: "contains" },
          { value: "NOT LIKE", label: "does not contain" },
          { value: "IN", label: "in" },
          { value: "NOT IN", label: "not in" }
        ];
      case "number":
      case "currency":
      case "percent":
        return [
          ...commonOperators,
          { value: ">", label: "greater than" },
          { value: ">=", label: "greater or equal" },
          { value: "<", label: "less than" },
          { value: "<=", label: "less or equal" }
        ];
      case "boolean":
        return commonOperators;
      case "date":
      case "datetime":
        return [
          ...commonOperators,
          { value: ">", label: "after" },
          { value: ">=", label: "on or after" },
          { value: "<", label: "before" },
          { value: "<=", label: "on or before" },
          { value: "LAST_N_DAYS:", label: "last n days" },
          { value: "NEXT_N_DAYS:", label: "next n days" }
        ];
      default:
        return commonOperators;
    }
  }

  render() {
    const { field, onRemove, onFieldSelect } = this.props;
    const { operator, value, showFieldSelector } = this.state;
    const operators = field ? this.getOperatorsForType(field.type) : [];

    return h("div", { className: "condition-block" },
      h("div", { className: "condition-header" },
        field 
          ? h("span", { className: "field-name" }, field.label)
          : h("button", {
              className: "select-field-button",
              onClick: () => this.setState({ showFieldSelector: true })
            }, "Select Field"),
        h("button", { 
          className: "remove-condition",
          onClick: onRemove
        }, "×")
      ),
      field && h("div", { className: "condition-content" },
        h("select", {
          value: operator,
          onChange: e => this.setState({ operator: e.target.value })
        },
          operators.map(op =>
            h("option", { key: op.value, value: op.value }, op.label)
          )
        ),
        h("input", {
          type: field.type === "number" ? "number" : "text",
          value: value,
          onChange: e => this.setState({ value: e.target.value }),
          placeholder: `Enter ${field.type} value...`
        })
      ),
      showFieldSelector && h(FieldSelectorModal, {
        fields: this.props.availableFields,
        selectedFields: this.props.selectedFields,
        onClose: () => this.setState({ showFieldSelector: false }),
        onSelect: ([selectedField]) => {
          onFieldSelect(selectedField);
          this.setState({ showFieldSelector: false });
        },
        singleSelect: true
      })
    );
  }
}

class FieldSelectorModal extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      searchTerm: "",
      selectedFields: new Set(Array.from(props.selectedFields || [])), // Initialize from props
      categoryFilter: "all"
    };
  }

  getFieldCategories() {
    const { fields } = this.props;
    const categories = new Set();
    fields?.forEach(field => {
      categories.add(field.type);
    });
    return ["all", ...Array.from(categories).sort()];
  }

  getFilteredFields() {
    const { fields } = this.props;
    const { searchTerm, categoryFilter } = this.state;
    
    return fields?.filter(field => {
      const matchesSearch = !searchTerm || 
        field.label.toLowerCase().includes(searchTerm.toLowerCase()) ||
        field.name.toLowerCase().includes(searchTerm.toLowerCase());
      
      const matchesCategory = categoryFilter === "all" || field.type === categoryFilter;
      
      return matchesSearch && matchesCategory;
    });
  }

  render() {
    const { onClose, onSelect, fields } = this.props;
    const { searchTerm, selectedFields, categoryFilter } = this.state;

    if (!fields) {
      return h("div", { className: "modal-overlay" },
        h("div", { className: "modal-content field-selector-modal" },
          h("div", { className: "modal-header" },
            h("h3", {}, "Select Fields"),
            h("button", { className: "modal-close", onClick: onClose }, "×")
          ),
          h("div", { className: "modal-body loading" },
            "Loading fields..."
          )
        )
      );
    }

    const categories = this.getFieldCategories();
    const filteredFields = this.getFilteredFields();

    return h("div", { className: "modal-overlay" },
      h("div", { className: "modal-content field-selector-modal" },
        h("div", { className: "modal-header" },
          h("h3", {}, "Select Fields"),
          h("button", { className: "modal-close", onClick: onClose }, "×")
        ),
        h("div", { className: "modal-body" },
          h("div", { className: "field-selector-controls" },
            h("input", {
              type: "text",
              className: "field-search",
              placeholder: "Search fields...",
              value: searchTerm,
              onChange: e => this.setState({ searchTerm: e.target.value })
            }),
            h("select", {
              value: categoryFilter,
              onChange: e => this.setState({ categoryFilter: e.target.value }),
              className: "category-filter"
            },
              categories.map(cat => 
                h("option", { key: cat, value: cat },
                  cat.charAt(0).toUpperCase() + cat.slice(1)
                )
              )
            )
          ),
          h("div", { className: "field-list" },
            filteredFields?.map(field =>
              h("div", {
                key: field.name,
                className: "field-item" + (selectedFields.has(field.name) ? " selected" : ""),
                onClick: () => {
                  const newSelected = new Set(selectedFields);
                  if (selectedFields.has(field.name)) {
                    newSelected.delete(field.name);
                  } else {
                    newSelected.add(field.name);
                  }
                  this.setState({ selectedFields: newSelected });
                }
              },
                h("div", { className: "field-item-header" },
                  h("span", { className: "field-item-label" }, field.label),
                  h("span", { className: "field-item-type" }, field.type)
                ),
                h("div", { className: "field-item-name" }, field.name)
              )
            )
          )
        ),
        h("div", { className: "modal-footer" },
          h("button", {
            className: "button secondary",
            onClick: onClose
          }, "Cancel"),
          h("button", {
            className: "button",
            onClick: () => {
              const selectedFieldObjects = fields.filter(f => selectedFields.has(f.name));
              onSelect(selectedFieldObjects);
            },
            disabled: selectedFields.size === 0
          }, "Add Fields")
        )
      )
    );
  }
}

class QueryBlockList extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      showFieldSelector: false,
      showConditionBuilder: false,
      showSortingOptions: false,
      limit: ''
    };
  }

  render() {
    const { model, fields } = this.props;
    const { showFieldSelector, showConditionBuilder, showSortingOptions, limit } = this.state;

    return h("div", { className: "query-builder-blocks" },
      h("div", { className: "blocks-toolbar" },
        h("button", {
          className: "button secondary",
          onClick: () => this.setState({ showFieldSelector: true })
        }, "Display Fields"),
        h("button", {
          className: "button secondary",
          onClick: () => this.setState({ showConditionBuilder: true })
        }, "Conditions"),
        h("button", {
          className: "button secondary",
          onClick: () => this.setState({ showSortingOptions: true })
        }, "Sorting"),
        h("div", { className: "limit-input" },
          h("label", {}, "Limit:"),
          h("input", {
            type: "number",
            value: limit,
            onChange: e => {
              const value = e.target.value;
              this.setState({ limit: value });
              model.queryBuilder.limit = value ? parseInt(value) : null;
              model.didUpdate();
            },
            placeholder: "No limit"
          })
        )
      ),
      showFieldSelector && h(FieldSelectorModal, {
        fields: fields,
        selectedFields: model.queryBuilder.selectedFields,
        onClose: () => this.setState({ showFieldSelector: false }),
        onSelect: (selectedFields) => {
          model.queryBuilder.selectedFields = new Set(selectedFields.map(f => f.name));
          model.didUpdate();
          this.setState({ showFieldSelector: false });
        }
      }),
      showConditionBuilder && h(AdvancedFilter, {
        fields: fields,
        onClose: () => this.setState({ showConditionBuilder: false }),
        onApply: ({ conditions, operator }) => {
          model.queryBuilder.conditions = conditions;
          model.queryBuilder.groupOperator = operator;
          model.didUpdate();
          this.setState({ showConditionBuilder: false });
        }
      }),
      showSortingOptions && h(SortingModal, {
        fields: fields,
        currentSorting: model.queryBuilder.orderBy,
        onClose: () => this.setState({ showSortingOptions: false }),
        onApply: (sorting) => {
          model.queryBuilder.orderBy = sorting;
          model.didUpdate();
          this.setState({ showSortingOptions: false });
        }
      })
    );
  }
}

class ExportOptionsModal extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      format: "excel",
      selectedFields: new Set(props.columns.map(col => col.field)),
      fileName: "export"
    };
  }

  render() {
    const { onClose, onExport, columns } = this.props;
    const { format, selectedFields, fileName } = this.state;

    return h("div", { className: "modal-overlay" },
      h("div", { className: "modal-content export-modal" },
        h("div", { className: "modal-header" },
          h("h3", {}, "Export Options"),
          h("button", { 
            className: "modal-close",
            onClick: onClose
          }, "×")
        ),
        h("div", { className: "modal-body" },
          h("div", { className: "export-section" },
            h("h4", {}, "Export Format"),
            h("div", { className: "format-options" },
              h("label", {},
                h("input", {
                  type: "radio",
                  name: "format",
                  value: "excel",
                  checked: format === "excel",
                  onChange: e => this.setState({ format: e.target.value })
                }),
                "Excel"
              ),
              h("label", {},
                h("input", {
                  type: "radio",
                  name: "format",
                  value: "csv",
                  checked: format === "csv",
                  onChange: e => this.setState({ format: e.target.value })
                }),
                "CSV"
              ),
              h("label", {},
                h("input", {
                  type: "radio",
                  name: "format",
                  value: "json",
                  checked: format === "json",
                  onChange: e => this.setState({ format: e.target.value })
                }),
                "JSON"
              )
            )
          ),
          h("div", { className: "export-section" },
            h("h4", {}, "File Name"),
            h("input", {
              type: "text",
              value: fileName,
              onChange: e => this.setState({ fileName: e.target.value }),
              className: "file-name-input"
            })
          ),
          h("div", { className: "export-section" },
            h("h4", {}, "Fields to Export"),
            h("div", { className: "field-selection" },
              h("div", { className: "field-selection-header" },
                h("label", {},
                  h("input", {
                    type: "checkbox",
                    checked: selectedFields.size === columns.length,
                    onChange: e => {
                      this.setState({
                        selectedFields: e.target.checked 
                          ? new Set(columns.map(col => col.field))
                          : new Set()
                      });
                    }
                  }),
                  "Select All"
                )
              ),
              h("div", { className: "field-selection-list" },
                columns.map(col =>
                  h("label", { key: col.field },
                    h("input", {
                      type: "checkbox",
                      checked: selectedFields.has(col.field),
                      onChange: e => {
                        const newSelected = new Set(selectedFields);
                        if (e.target.checked) {
                          newSelected.add(col.field);
                        } else {
                          newSelected.delete(col.field);
                        }
                        this.setState({ selectedFields: newSelected });
                      }
                    }),
                    col.label
                  )
                )
              )
            )
          )
        ),
        h("div", { className: "modal-footer" },
          h("button", {
            className: "button secondary",
            onClick: onClose
          }, "Cancel"),
          h("button", {
            className: "button",
            onClick: () => onExport({
              format,
              fileName,
              fields: Array.from(selectedFields)
            }),
            disabled: selectedFields.size === 0
          }, "Export")
        )
      )
    );
  }
}

class QueryValidator {
  static validateQuery(query, objectMetadata, fieldMetadata) {
    const errors = [];
    
    // Check basic structure
    if (!query.includes("SELECT") || !query.includes("FROM")) {
      errors.push("Query must include SELECT and FROM clauses");
      return errors;
    }

    // Check object exists
    const fromMatch = query.match(/FROM\s+(\w+)/i);
    if (fromMatch) {
      const objectName = fromMatch[1];
      if (!objectMetadata.find(obj => obj.name === objectName)) {
        errors.push(`Object "${objectName}" not found`);
      }
    }

    // Check fields exist
    const selectMatch = query.match(/SELECT\s+(.*?)\s+FROM/i);
    if (selectMatch) {
      const fields = selectMatch[1].split(',').map(f => f.trim());
      fields.forEach(field => {
        if (field === '*') {
          errors.push("Wildcard (*) selections are not supported");
        } else if (field !== 'Id' && !fieldMetadata?.find(f => f.name === field)) {
          errors.push(`Field "${field}" not found`);
        }
      });
    }

    // Check WHERE clause syntax
    const whereMatch = query.match(/WHERE\s+(.*?)(?:\s+ORDER BY|\s+LIMIT|$)/i);
    if (whereMatch) {
      const whereClause = whereMatch[1];
      if ((whereClause.match(/\(/g) || []).length !== (whereClause.match(/\)/g) || []).length) {
        errors.push("Unmatched parentheses in WHERE clause");
      }
    }

    return errors;
  }

  static suggestQuery(partialQuery, objectMetadata, fieldMetadata) {
    const suggestions = [];
    
    // Suggest objects
    if (partialQuery.toLowerCase().includes("from") && !partialQuery.toLowerCase().includes("where")) {
      const fromMatch = partialQuery.match(/FROM\s+(\w*)$/i);
      if (fromMatch) {
        const partial = fromMatch[1].toLowerCase();
        suggestions.push(...objectMetadata
          .filter(obj => obj.name.toLowerCase().startsWith(partial))
          .map(obj => ({
            type: 'object',
            text: obj.name,
            description: obj.label
          })));
      }
    }

    // Suggest fields
    if (fieldMetadata && partialQuery.match(/SELECT\s*$/i)) {
      suggestions.push(...fieldMetadata
        .map(field => ({
          type: 'field',
          text: field.name,
          description: field.label
        })));
    }

    return suggestions;
  }
}

class ResultsTable extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      sortColumn: null,
      sortDirection: 'asc',
      page: 1,
      pageSize: 50,
      selectedRows: new Set(),
      showBatchModal: false
    };
  }

  getColumns() {
    const { data } = this.props;
    if (!data || !data.records || data.records.length === 0) return [];

    const record = data.records[0];
    return Object.keys(record)
      .filter(key => key !== 'attributes')
      .map(key => ({
        field: key,
        label: key.replace(/__c$/i, '').split('_').map(word => 
          word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        ).join(' ')
      }));
  }

  getSortedData() {
    const { data } = this.props;
    const { sortColumn, sortDirection, page, pageSize } = this.state;

    if (!data || !data.records) return [];

    let records = [...data.records];

    if (sortColumn) {
      records.sort((a, b) => {
        const aVal = a[sortColumn] || '';
        const bVal = b[sortColumn] || '';
        return sortDirection === 'asc' 
          ? String(aVal).localeCompare(String(bVal))
          : String(bVal).localeCompare(String(aVal));
      });
    }

    const start = (page - 1) * pageSize;
    return records.slice(start, start + pageSize);
  }

  exportData(options) {
    const { data } = this.props;
    const { format, fileName, fields } = options;
    
    if (!data || !data.records) return;

    const records = data.records;
    let content = '';
    
    switch (format) {
      case 'excel':
        content = this.exportToExcel(records, fields);
        break;
      case 'csv':
        content = this.exportToCsv(records, fields);
        break;
      case 'json':
        content = this.exportToJson(records, fields);
        break;
    }

    this.downloadFile(content, fileName, format);
  }

  exportToExcel(records, fields) {
    return records
      .map(record => fields
        .map(field => `"${String(record[field] || '').replace(/"/g, '""')}"`)
        .join('\t')
      )
      .join('\n');
  }

  exportToCsv(records, fields) {
    return records
      .map(record => fields
        .map(field => `"${String(record[field] || '').replace(/"/g, '""')}"`)
        .join(',')
      )
      .join('\n');
  }

  exportToJson(records, fields) {
    return JSON.stringify(
      records.map(record => 
        fields.reduce((obj, field) => {
          obj[field] = record[field];
          return obj;
        }, {})
      ),
      null,
      2
    );
  }

  downloadFile(content, fileName, format) {
    const extensions = {
      excel: 'xls',
      csv: 'csv',
      json: 'json'
    };

    const blob = new Blob([content], { 
      type: format === 'json' 
        ? 'application/json' 
        : 'text/plain' 
    });
    
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${fileName}.${extensions[format]}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  render() {
    const { data } = this.props;
    const { sortColumn, sortDirection, page, pageSize, selectedRows } = this.state;
    const columns = this.getColumns();
    const records = this.getSortedData();
    const totalPages = Math.ceil((data?.records?.length || 0) / pageSize);

    return h("div", { className: "results-table-container" },
      h("div", { className: "results-table-header" },
        h("div", { className: "results-count" },
          data?.records?.length 
            ? `${data.records.length} record${data.records.length === 1 ? '' : 's'}`
            : "No records"
        ),
        h("div", { className: "table-controls" },
          selectedRows.size > 0 && h("button", {
            className: "button",
            onClick: () => this.setState({ showBatchModal: true })
          }, `Batch Operations (${selectedRows.size})`),
          h("select", {
            value: pageSize,
            onChange: e => this.setState({ pageSize: Number(e.target.value), page: 1 })
          },
            [10, 25, 50, 100].map(size =>
              h("option", { key: size, value: size }, `${size} per page`)
            )
          )
        )
      ),
      h("div", { className: "results-table-scroll" },
        h("table", { className: "results-table" },
          h("thead", {},
            h("tr", {},
              h("th", { className: "select-column" },
                h("input", {
                  type: "checkbox",
                  checked: selectedRows.size === records.length,
                  onChange: e => {
                    this.setState({
                      selectedRows: e.target.checked 
                        ? new Set(records.map(r => r.Id))
                        : new Set()
                    });
                  }
                })
              ),
              columns.map(col =>
                h("th", {
                  key: col.field,
                  className: sortColumn === col.field ? `sorted-${sortDirection}` : '',
                  onClick: () => {
                    this.setState(state => ({
                      sortColumn: col.field,
                      sortDirection: state.sortColumn === col.field && state.sortDirection === 'asc'
                        ? 'desc'
                        : 'asc'
                    }));
                  }
                },
                  h("div", { className: "th-content" },
                    col.label,
                    sortColumn === col.field && h("span", { 
                      className: `sort-indicator ${sortDirection}` 
                    })
                  )
                )
              )
            )
          ),
          h("tbody", {},
            records.map((record, index) =>
              h("tr", { 
                key: record.Id || index,
                className: selectedRows.has(record.Id) ? 'selected' : ''
              },
                h("td", { className: "select-column" },
                  h("input", {
                    type: "checkbox",
                    checked: selectedRows.has(record.Id),
                    onChange: e => {
                      const newSelected = new Set(selectedRows);
                      if (e.target.checked) {
                        newSelected.add(record.Id);
                      } else {
                        newSelected.delete(record.Id);
                      }
                      this.setState({ selectedRows: newSelected });
                    }
                  })
                ),
                columns.map(col =>
                  h("td", { key: col.field },
                    this.formatCellValue(record[col.field])
                  )
                )
              )
            )
          )
        )
      ),
      h("div", { className: "results-table-footer" },
        h("div", { className: "pagination" },
          h("button", {
            className: "button secondary",
            disabled: page === 1,
            onClick: () => this.setState({ page: page - 1 })
          }, "Previous"),
          h("span", { className: "page-info" },
            `Page ${page} of ${totalPages}`
          ),
          h("button", {
            className: "button secondary",
            disabled: page === totalPages,
            onClick: () => this.setState({ page: page + 1 })
          }, "Next")
        )
      ),
      this.state.showBatchModal && h(BatchOperationsModal, {
        selectedRecords: Array.from(selectedRows),
        fields: columns,
        onClose: () => this.setState({ showBatchModal: false }),
        onExecute: (operation, fieldValues) => {
          this.props.onBatchOperation(operation, Array.from(selectedRows), fieldValues);
          this.setState({ showBatchModal: false });
        }
      })
    );
  }

  formatCellValue(value) {
    if (value == null) return '';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
}

class ResultsPanel extends React.Component {
  render() {
    const { results, isLoading, error } = this.props;
    
    if (isLoading) {
      return h("div", { className: "results-loading" },
        h("div", { className: "spinner" }),
        "Loading..."
      );
    }
    
    if (error) {
      return h("div", { className: "results-error" },
        h("div", { className: "error-icon" }, "⚠️"),
        h("div", { className: "error-message" }, error)
      );
    }
    
    if (!results) {
      return h("div", { className: "results-empty" }, 
        h("div", { className: "empty-icon" }, "📊"),
        h("div", { className: "empty-message" }, "Execute a query to see results")
      );
    }
    
    return h(ResultsTable, { data: results });
  }
}

class TemplateSelector extends React.Component {
  render() {
    const { onSelect } = this.props;

    return h("div", { className: "template-selector" },
      h("h3", {}, "Query Templates"),
      h("div", { className: "template-list" },
        Object.entries(QueryTemplates.templates).map(([id, template]) =>
          h("div", {
            key: id,
            className: "template-item",
            onClick: () => onSelect(id)
          },
            h("div", { className: "template-name" }, template.name),
            h("div", { className: "template-preview" }, template.query)
          )
        )
      )
    );
  }
}

class QuerySuggestions extends React.Component {
  render() {
    const { suggestions } = this.props;
    
    if (!suggestions || suggestions.length === 0) {
      return null;
    }

    return h("div", { className: "query-suggestions" },
      h("h3", {}, "Query Suggestions"),
      h("ul", { className: "suggestion-list" },
        suggestions.map((suggestion, index) =>
          h("li", {
            key: index,
            className: `suggestion-item ${suggestion.severity}`
          },
            h("div", { className: "suggestion-icon" },
              suggestion.severity === 'warning' ? '⚠️' : 'ℹ️'
            ),
            h("div", { className: "suggestion-content" },
              h("div", { className: "suggestion-message" },
                suggestion.message
              ),
              h("div", { className: "suggestion-fix" },
                suggestion.fix
              )
            )
          )
        )
      )
    );
  }
}

class BatchOperationsModal extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      operation: 'update',
      fieldValues: {},
      confirmDelete: false
    };
  }

  render() {
    const { onClose, onExecute, selectedRecords, fields } = this.props;
    const { operation, fieldValues, confirmDelete } = this.state;

    return h("div", { className: "modal-overlay" },
      h("div", { className: "modal-content batch-modal" },
        h("div", { className: "modal-header" },
          h("h3", {}, `Batch ${operation.charAt(0).toUpperCase() + operation.slice(1)}`),
          h("button", { className: "modal-close", onClick: onClose }, "×")
        ),
        h("div", { className: "modal-body" },
          h("div", { className: "batch-info" },
            `Selected records: ${selectedRecords.length}`
          ),
          h("div", { className: "operation-selector" },
            h("select", {
              value: operation,
              onChange: e => this.setState({ 
                operation: e.target.value,
                fieldValues: {},
                confirmDelete: false
              })
            },
              h("option", { value: "update" }, "Update"),
              h("option", { value: "delete" }, "Delete")
            )
          ),
          operation === 'update' && h("div", { className: "field-updates" },
            fields.map(field =>
              h("div", { className: "field-update-row", key: field.name },
                h("label", {},
                  h("input", {
                    type: "checkbox",
                    checked: fieldValues.hasOwnProperty(field.name),
                    onChange: e => {
                      const newValues = { ...fieldValues };
                      if (e.target.checked) {
                        newValues[field.name] = '';
                      } else {
                        delete newValues[field.name];
                      }
                      this.setState({ fieldValues: newValues });
                    }
                  }),
                  field.label
                ),
                fieldValues.hasOwnProperty(field.name) && 
                h("input", {
                  type: this.getInputType(field.type),
                  value: fieldValues[field.name],
                  onChange: e => this.setState({
                    fieldValues: {
                      ...fieldValues,
                      [field.name]: e.target.value
                    }
                  })
                })
              )
            )
          ),
          operation === 'delete' && !confirmDelete && 
          h("div", { className: "delete-warning" },
            h("p", {}, "⚠️ This will permanently delete the selected records."),
            h("button", {
              className: "button warning",
              onClick: () => this.setState({ confirmDelete: true })
            }, "I understand, proceed with deletion")
          )
        ),
        h("div", { className: "modal-footer" },
          h("button", {
            className: "button secondary",
            onClick: onClose
          }, "Cancel"),
          h("button", {
            className: "button",
            disabled: (operation === 'update' && Object.keys(fieldValues).length === 0) ||
                     (operation === 'delete' && !confirmDelete),
            onClick: () => onExecute(operation, fieldValues)
          }, operation === 'update' ? "Update Records" : "Delete Records")
        )
      )
    );
  }

  getInputType(fieldType) {
    switch (fieldType) {
      case 'boolean': return 'checkbox';
      case 'date': return 'date';
      case 'datetime': return 'datetime-local';
      case 'number':
      case 'currency':
      case 'percent': return 'number';
      default: return 'text';
    }
  }
}

class App extends React.Component {
  render() {
    const { model } = this.props;
    
    return h("div", { className: "modern-export-container" },
      h("div", { className: "query-builder" },
        h("div", { className: "query-builder-header" },
          h("h2", {}, "Query Builder"),
          h(ObjectSelector, {
            objects: model.objectMetadata,
            selectedObject: model.queryBuilder.selectedObject,
            onSelect: (obj) => {
              model.queryBuilder.selectedObject = obj;
              model.didUpdate();
            },
            onObjectSelect: async (objectName) => {
              await model.loadFieldMetadata(objectName);
            }
          })
        ),
        h("div", { className: "query-builder-content" },
          h(QueryBlockList, { 
            model: model,
            fields: model.fieldMetadata 
          })
        ),
        // Selected Fields display
        model.queryBuilder.selectedFields.size > 0 && h("div", { className: "selected-fields-display" },
          h("h3", {}, "Selected Fields"),
          h("div", { className: "selected-fields-list" },
            Array.from(model.queryBuilder.selectedFields).map(fieldName =>
              h("span", { key: fieldName, className: "selected-field-tag" },
                fieldName,
                h("button", {
                  onClick: () => {
                    model.queryBuilder.selectedFields.delete(fieldName);
                    model.didUpdate();
                  }
                }, "×")
              )
            )
          )
        ),
        // Conditions display
        model.queryBuilder.conditions?.length > 0 && h("div", { className: "conditions-display" },
          h("h3", {}, "Conditions"),
          h("div", { className: "conditions-summary" },
            h("div", { className: "operator-badge" }, 
              model.queryBuilder.groupOperator === "AND" ? "ALL" : "ANY"
            ),
            h("div", { className: "conditions-list" },
              model.queryBuilder.conditions.map(condition =>
                h("div", { 
                  key: condition.id, 
                  className: `condition-tag operator-${condition.operator.toLowerCase().replace(/[^a-z]/g, '-')}` 
                },
                  h("span", { className: "condition-field" }, condition.field),
                  h("span", { className: "condition-operator" }, 
                    this.getOperators().find(op => op.value === condition.operator)?.label || condition.operator
                  ),
                  h("span", { className: "condition-value" }, condition.value),
                  h("button", {
                    onClick: () => {
                      model.queryBuilder.conditions = model.queryBuilder.conditions
                        .filter(c => c.id !== condition.id);
                      model.didUpdate();
                    }
                  }, "×")
                )
              )
            )
          )
        ),
        // Sorting display
        model.queryBuilder.orderBy?.length > 0 && h("div", { className: "sorting-display" },
          h("h3", {}, "Sorting"),
          h("div", { className: "sorting-list" },
            model.queryBuilder.orderBy.map((sort, index) =>
              h("div", { key: index, className: "sorting-tag" },
                h("span", { className: "sorting-field" }, sort.field),
                h("span", { className: "sorting-direction" }, sort.direction),
                h("button", {
                  onClick: () => {
                    model.queryBuilder.orderBy = model.queryBuilder.orderBy
                      .filter((_, i) => i !== index);
                    model.didUpdate();
                  }
                }, "×")
              )
            )
          )
        )
      ),
      h("div", { className: "results-panel" },
        h("div", { className: "results-header" },
          h("button", {
            className: "button",
            onClick: () => {
              const query = model.queryBuilder.buildQuery();
              model.executeQuery(query);
            }
          }, "Execute Query"),
          h("button", {
            className: "button secondary",
            disabled: !model.results,
            onClick: () => {/* Export logic */}
          }, "Export Results")
        ),
        h("div", { className: "results-content" },
          h(ResultsPanel, {
            results: model.results,
            isLoading: model.isLoading,
            error: model.error
          })
        )
      )
    );
  }

  getOperators() {
    return [
      { value: "=", label: "equals", key: "equals" },
      { value: "!=", label: "not equals", key: "not-equals" },
      { value: ">", label: "greater than", key: "greater-than" },
      { value: ">=", label: "greater or equal", key: "greater-equal" },
      { value: "<", label: "less than", key: "less-than" },
      { value: "<=", label: "less or equal", key: "less-equal" },
      { value: "LIKE", label: "contains", key: "contains" },
      { value: "NOT LIKE", label: "not contains", key: "not-contains" },
      { value: "IN", label: "in", key: "in" },
      { value: "NOT IN", label: "not in", key: "not-in" },
      { value: "INCLUDES", label: "includes", key: "includes" },
      { value: "EXCLUDES", label: "excludes", key: "excludes" },
      { value: "=", label: "is", key: "is" }
    ];
  }
}

// Initialize the app
let args = new URLSearchParams(location.search.slice(1));
let sfHost = args.get("host");
initButton(sfHost, true);

sfConn.getSession(sfHost).then(() => {
  let root = document.getElementById("root");
  let model = new ModernExportModel(sfHost);
  
  model.reactCallback = cb => {
    ReactDOM.render(h(App, { model }), root, cb);
  };
  
  // Load initial data
  model.loadObjectMetadata();
  
  ReactDOM.render(h(App, { model }), root);
});

class RelationshipFieldSelector extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      path: [],
      showDropdown: false,
      loading: false,
      relatedFields: null
    };
  }

  async loadRelatedFields(relationship) {
    const { model } = this.props;
    const { path } = this.state;
    
    this.setState({ loading: true });
    try {
      const objectName = relationship.referenceTo[0];
      const response = await sfConn.rest(`/services/data/v${apiVersion}/sobjects/${objectName}/describe`);
      this.setState({ 
        relatedFields: response.fields,
        loading: false 
      });
    } catch (error) {
      this.setState({ 
        error: error.message,
        loading: false 
      });
    }
  }

  getAvailableRelationships() {
    const { fieldMetadata } = this.props;
    const { path } = this.state;
    
    if (path.length === 0) {
      return fieldMetadata?.filter(f => f.type === 'reference') || [];
    }
    
    return this.state.relatedFields?.filter(f => f.type === 'reference') || [];
  }

  buildFieldPath() {
    return this.state.path.join('.');
  }

  render() {
    const { onSelect } = this.props;
    const { path, showDropdown, loading } = this.state;
    const relationships = this.getAvailableRelationships();

    return h("div", { className: "relationship-selector" },
      h("div", { className: "relationship-breadcrumb" },
        path.map((item, index) =>
          h("span", { key: index, className: "relationship-breadcrumb-item" },
            item,
            index < path.length - 1 && h("span", { className: "relationship-breadcrumb-separator" }, "→")
          )
        ),
        h("button", {
          className: "add-relationship-button",
          onClick: () => this.setState({ showDropdown: !showDropdown })
        }, "+")
      ),
      showDropdown && h("div", { className: "relationship-dropdown" },
        loading 
          ? h("div", { className: "loading-indicator" }, "Loading...")
          : relationships.map(rel =>
              h("div", {
                key: rel.name,
                className: "relationship-option",
                onClick: async () => {
                  const newPath = [...path, rel.relationshipName];
                  this.setState({ path: newPath });
                  await this.loadRelatedFields(rel);
                  onSelect(this.buildFieldPath());
                }
              },
                h("div", { className: "relationship-option-name" }, rel.label),
                h("div", { className: "relationship-option-type" }, rel.referenceTo.join(', '))
              )
            )
      )
    );
  }
}

// Add new AdvancedFilter component
class AdvancedFilter extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      conditions: [],
      operator: 'AND',
      searchTerm: '',
      categoryFilter: 'all',
      showFieldSelector: false,
      editingConditionId: null
    };
  }

  addCondition() {
    this.setState({ 
      showFieldSelector: true,
      editingConditionId: null
    });
  }

  updateCondition(id, updates) {
    this.setState(state => ({
      conditions: state.conditions.map(c =>
        c.id === id ? { ...c, ...updates } : c
      )
    }));
  }

  removeCondition(id) {
    this.setState(state => ({
      conditions: state.conditions.filter(c => c.id !== id)
    }));
  }

  onFieldSelect(field) {
    const condition = {
      id: Date.now(),
      field: field.name,
      fieldLabel: field.label,
      operator: '=',
      value: '',
      valueType: 'literal'
    };

    this.setState(state => ({
      conditions: [...state.conditions, condition],
      showFieldSelector: false
    }));
  }

  getOperators() {
    return [
      { value: "=", label: "equals", key: "equals" },
      { value: "!=", label: "not equals", key: "not-equals" },
      { value: ">", label: "greater than", key: "greater-than" },
      { value: ">=", label: "greater or equal", key: "greater-equal" },
      { value: "<", label: "less than", key: "less-than" },
      { value: "<=", label: "less or equal", key: "less-equal" },
      { value: "LIKE", label: "contains", key: "contains" },
      { value: "NOT LIKE", label: "not contains", key: "not-contains" },
      { value: "IN", label: "in", key: "in" },
      { value: "NOT IN", label: "not in", key: "not-in" },
      { value: "INCLUDES", label: "includes", key: "includes" },
      { value: "EXCLUDES", label: "excludes", key: "excludes" },
      { value: "=", label: "is", key: "is" }
    ];
  }

  render() {
    const { conditions, operator, showFieldSelector } = this.state;
    const { fields, onClose, onApply } = this.props;

    return h("div", { className: "modal-overlay" },
      h("div", { className: "modal-content conditions-modal" },
        h("div", { className: "modal-header" },
          h("h3", {}, "Add Conditions"),
          h("button", { className: "modal-close", onClick: onClose }, "×")
        ),
        h("div", { className: "modal-body" },
          h("div", { className: "filter-header" },
            h("select", {
              value: operator,
              onChange: e => this.setState({ operator: e.target.value })
            },
              h("option", { value: "AND" }, "Match ALL conditions (AND)"),
              h("option", { value: "OR" }, "Match ANY condition (OR)")
            )
          ),
          h("div", { className: "conditions-list" },
            conditions.map(condition =>
              h("div", { key: condition.id, className: "condition-item" },
                h("div", { className: "condition-field" },
                  h("span", { className: "field-label" }, condition.fieldLabel)
                ),
                h("select", {
                  value: condition.operator,
                  onChange: e => this.updateCondition(condition.id, { operator: e.target.value })
                },
                  this.getOperators().map(op =>
                    h("option", { key: op.key, value: op.value }, op.label)
                  )
                ),
                h("input", {
                  type: "text",
                  value: condition.value,
                  onChange: e => this.updateCondition(condition.id, { value: e.target.value }),
                  placeholder: "Enter value"
                }),
                h("button", {
                  className: "remove-condition",
                  onClick: () => this.removeCondition(condition.id)
                }, "×")
              )
            ),
            h("button", {
              className: "button secondary",
              onClick: () => this.addCondition()
            }, "Add Condition")
          )
        ),
        h("div", { className: "modal-footer" },
          h("button", {
            className: "button secondary",
            onClick: onClose
          }, "Cancel"),
          h("button", {
            className: "button",
            onClick: () => onApply({ conditions, operator })
          }, "Apply Conditions")
        ),
        showFieldSelector && h(FieldSelectorModal, {
          fields: fields,
          onClose: () => this.setState({ showFieldSelector: false }),
          onSelect: ([field]) => this.onFieldSelect(field),
          singleSelect: true
        })
      )
    );
  }
}

// Add new QueryManagementPanel component
class QueryManagementPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      activeTab: 'templates',
      showSaveDialog: false,
      queryName: '',
      queryDescription: ''
    };
  }

  render() {
    const { model, onSelectQuery } = this.props;
    const { activeTab, showSaveDialog } = this.state;

    return h("div", { className: "query-management-panel" },
      h("div", { className: "panel-tabs" },
        h("button", {
          className: `tab-button ${activeTab === 'templates' ? 'active' : ''}`,
          onClick: () => this.setState({ activeTab: 'templates' })
        }, "Templates"),
        h("button", {
          className: `tab-button ${activeTab === 'saved' ? 'active' : ''}`,
          onClick: () => this.setState({ activeTab: 'saved' })
        }, "Saved Queries"),
        h("button", {
          className: `tab-button ${activeTab === 'history' ? 'active' : ''}`,
          onClick: () => this.setState({ activeTab: 'history' })
        }, "History")
      ),
      activeTab === 'templates' && h(TemplateList, {
        templates: QueryTemplates.templates,
        onSelect: onSelectQuery
      }),
      activeTab === 'saved' && h(SavedQueriesList, {
        queries: model.savedQueries.getAll(),
        onSelect: onSelectQuery,
        onDelete: id => model.savedQueries.delete(id)
      }),
      activeTab === 'history' && h(QueryHistoryList, {
        history: model.queryHistory.getAll(),
        onSelect: onSelectQuery,
        onClear: () => {
          model.queryHistory.clear();
          model.didUpdate();
        }
      }),
      showSaveDialog && h(SaveQueryDialog, {
        onSave: (name, description) => {
          model.savedQueries.save({
            name,
            description,
            query: model.queryBuilder.buildQuery(),
            object: model.queryBuilder.selectedObject
          });
          this.setState({ showSaveDialog: false });
          model.didUpdate();
        },
        onClose: () => this.setState({ showSaveDialog: false })
      })
    );
  }
}

// Add new SaveQueryDialog component
class SaveQueryDialog extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      name: '',
      description: ''
    };
  }

  render() {
    const { onSave, onClose } = this.props;
    const { name, description } = this.state;

    return h("div", { className: "modal-overlay" },
      h("div", { className: "modal-content save-query-modal" },
        h("div", { className: "modal-header" },
          h("h3", {}, "Save Query"),
          h("button", { className: "modal-close", onClick: onClose }, "×")
        ),
        h("div", { className: "modal-body" },
          h("div", { className: "form-group" },
            h("label", {}, "Query Name"),
            h("input", {
              type: "text",
              value: name,
              onChange: e => this.setState({ name: e.target.value }),
              placeholder: "Enter a name for your query"
            })
          ),
          h("div", { className: "form-group" },
            h("label", {}, "Description"),
            h("textarea", {
              value: description,
              onChange: e => this.setState({ description: e.target.value }),
              placeholder: "Enter a description (optional)"
            })
          )
        ),
        h("div", { className: "modal-footer" },
          h("button", {
            className: "button secondary",
            onClick: onClose
          }, "Cancel"),
          h("button", {
            className: "button",
            disabled: !name.trim(),
            onClick: () => onSave(name, description)
          }, "Save Query")
        )
      )
    );
  }
}

// Add new SavedQueriesList component
class SavedQueriesList extends React.Component {
  render() {
    const { queries, onSelect, onDelete } = this.props;

    if (queries.length === 0) {
      return h("div", { className: "empty-state" },
        h("div", { className: "empty-icon" }, "📁"),
        h("div", { className: "empty-message" }, "No saved queries yet")
      );
    }

    return h("div", { className: "saved-queries-list" },
      queries.map(query =>
        h("div", { key: query.id, className: "saved-query-item" },
          h("div", { className: "saved-query-info" },
            h("div", { className: "saved-query-name" }, query.name),
            query.description && h("div", { className: "saved-query-description" }, query.description),
            h("div", { className: "saved-query-meta" },
              h("span", { className: "saved-query-object" }, query.object),
              h("span", { className: "saved-query-date" },
                new Date(query.timestamp).toLocaleDateString()
              )
            )
          ),
          h("div", { className: "saved-query-actions" },
            h("button", {
              className: "button secondary small",
              onClick: () => onSelect(query)
            }, "Load"),
            h("button", {
              className: "button danger small",
              onClick: () => onDelete(query.id)
            }, "Delete")
          )
        )
      )
    );
  }
}

// Add new QueryHistoryList component
class QueryHistoryList extends React.Component {
  render() {
    const { history, onSelect, onClear } = this.props;

    if (history.length === 0) {
      return h("div", { className: "empty-state" },
        h("div", { className: "empty-icon" }, "📜"),
        h("div", { className: "empty-message" }, "No query history")
      );
    }

    return h("div", { className: "query-history-list" },
      h("div", { className: "history-header" },
        h("h3", {}, "Recent Queries"),
        h("button", {
          className: "button secondary small",
          onClick: onClear
        }, "Clear History")
      ),
      history.map((item, index) =>
        h("div", { key: index, className: "history-item" },
          h("div", { className: "history-query" },
            h("pre", {}, item.query)
          ),
          h("div", { className: "history-meta" },
            h("span", { className: "history-date" },
              new Date(item.timestamp).toLocaleString()
            ),
            h("button", {
              className: "button secondary small",
              onClick: () => onSelect(item)
            }, "Use")
          )
        )
      )
    );
  }
}

class SortingModal extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      sortFields: props.currentSorting || [],
      searchTerm: '',
      categoryFilter: 'all'
    };
  }

  getFilteredFields() {
    const { fields } = this.props;
    const { searchTerm, categoryFilter } = this.state;
    
    return fields?.filter(field => {
      const matchesSearch = !searchTerm || 
        field.label.toLowerCase().includes(searchTerm.toLowerCase()) ||
        field.name.toLowerCase().includes(searchTerm.toLowerCase());
      
      const matchesCategory = categoryFilter === "all" || field.type === categoryFilter;
      
      return matchesSearch && matchesCategory;
    });
  }

  render() {
    const { onClose, onApply } = this.props;
    const { sortFields, searchTerm, categoryFilter } = this.state;
    const filteredFields = this.getFilteredFields();

    return h("div", { className: "modal-overlay" },
      h("div", { className: "modal-content sorting-modal" },
        h("div", { className: "modal-header" },
          h("h3", {}, "Sort Results"),
          h("button", { className: "modal-close", onClick: onClose }, "×")
        ),
        h("div", { className: "modal-body" },
          h("div", { className: "field-selector-controls" },
            h("input", {
              type: "text",
              className: "field-search",
              placeholder: "Search fields...",
              value: searchTerm,
              onChange: e => this.setState({ searchTerm: e.target.value })
            })
          ),
          sortFields.map((sort, index) =>
            h("div", { key: index, className: "sort-field-row" },
              h("select", {
                value: sort.field,
                onChange: e => this.updateSortField(index, { field: e.target.value })
              },
                h("option", { value: "" }, "Select field"),
                filteredFields.map(f =>
                  h("option", { key: f.name, value: f.name }, f.label)
                )
              ),
              h("select", {
                value: sort.direction,
                onChange: e => this.updateSortField(index, { direction: e.target.value })
              },
                h("option", { value: "ASC" }, "Ascending"),
                h("option", { value: "DESC" }, "Descending")
              ),
              h("button", {
                className: "remove-sort",
                onClick: () => this.removeSortField(index)
              }, "×")
            )
          ),
          h("button", {
            className: "button secondary",
            onClick: () => this.addSortField()
          }, "Add Sort Field")
        ),
        h("div", { className: "modal-footer" },
          h("button", {
            className: "button secondary",
            onClick: onClose
          }, "Cancel"),
          h("button", {
            className: "button",
            onClick: () => onApply(sortFields.filter(f => f.field))
          }, "Apply Sorting")
        )
      )
    );
  }

  addSortField() {
    this.setState(state => ({
      sortFields: [...state.sortFields, { field: '', direction: 'ASC' }]
    }));
  }

  updateSortField(index, updates) {
    this.setState(state => ({
      sortFields: state.sortFields.map((field, i) =>
        i === index ? { ...field, ...updates } : field
      )
    }));
  }

  removeSortField(index) {
    this.setState(state => ({
      sortFields: state.sortFields.filter((_, i) => i !== index)
    }));
  }
} 