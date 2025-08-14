// parser.js - Web Worker for XML Processing

/**
 * Listens for a message from the main thread, containing the XML string to parse.
 * It performs the parsing and sends the structured data or an error back.
 */
self.onmessage = function(event) {
    const { task, xml } = event.data;
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xml, "application/xml");

        if (doc.querySelector('parsererror')) {
            throw new Error('XML parsing error. Please ensure the file content is valid and was copied correctly.');
        }

        let result;
        if (task === 'parseCombined') {
            const finalOutputNode = doc.querySelector('FinalOutput');
            if (!finalOutputNode) throw new Error('The root <FinalOutput> tag was not found. The SQL query may have failed or produced an unexpected result.');

            const layoutNode = finalOutputNode.querySelector('Layouts > Layouts');
            const fieldNode = finalOutputNode.querySelector('Fields > Fields');

            if (!layoutNode) throw new Error('Could not find <Layouts> data within <FinalOutput>. Please check the generated XML.');

            const layoutData = _parseLayouts(layoutNode);
            const dbData = fieldNode ? _parseDbXml(fieldNode) : new Map();

            // Web Workers can't transfer Maps directly, so we convert them to Arrays of [key, value] pairs.
            // They will be converted back to Maps on the main thread.
            result = {
                ...layoutData,
                masterFieldMap: Array.from(layoutData.masterFieldMap.entries()),
                cards: Array.from(layoutData.cards.entries()),
                buttons: Array.from(layoutData.buttons.entries()),
                profileMapping: Array.from(layoutData.profileMapping.entries()),
                dbData: Array.from(dbData.entries()),
            };
        }
        // Send the processed data back to the main thread
        self.postMessage({ success: true, data: result });
    } catch (e) {
        // Send an error object back to the main thread
        self.postMessage({ success: false, error: { message: e.message, stack: e.stack } });
    }
};

/**
 * Parses the main layout XML structure.
 * @param {Document} doc - The XML document node containing layout data.
 * @returns {object} An object containing maps of all parsed layout entities.
 */
function _parseLayouts(doc) {
    const masterFieldMap = new Map(), profileMapping = new Map(), cards = new Map(), buttons = new Map();
    _processLayouts(doc, 'NewEditLayouts', 'newEdit', { masterFieldMap, profileMapping, cards, buttons });
    _processLayouts(doc, 'DetailLayoutsGroup > DetailLayout', 'detail', { masterFieldMap, profileMapping, cards, buttons });
    _processLayouts(doc, 'HistoryLayoutsGroup > HistoryLayout', 'history', { masterFieldMap, profileMapping, cards, buttons });
    return { masterFieldMap, profileMapping, cards, buttons };
}

/**
 * Processes a group of layouts for a specific type (e.g., 'newEdit', 'detail').
 * @param {Document} doc - The XML document.
 * @param {string} selector - The CSS selector to find layout groups.
 * @param {string} type - The type of layout being processed.
 * @param {object} dataMaps - An object containing the master maps to populate.
 */
function _processLayouts(doc, selector, type, dataMaps) {
    doc.querySelectorAll(selector).forEach(node => {
        const groupID = node.getAttribute('GroupID');
        node.querySelectorAll('Layout > LayoutXML').forEach(xmlNode => {
            if (!xmlNode.textContent) return;
            const innerDoc = new DOMParser().parseFromString(xmlNode.textContent, "application/xml");
            if (innerDoc.querySelector('parsererror')) return;
            const layoutName = innerDoc.documentElement.getAttribute('layoutname') || 'Unknown Layout';
            if (groupID !== null) { const profileName = layoutName.split(':').pop().trim(); if (profileName) dataMaps.profileMapping.set(groupID, { Profile: profileName, Type: type, GroupID: groupID });}
            innerDoc.querySelectorAll('control[CardName]').forEach(ctrl => { const cardName = ctrl.querySelector('property[name="CardName"]')?.getAttribute('value'); if (cardName) dataMaps.cards.set(`${layoutName}-${cardName}`, { Name: cardName, Layout: layoutName }); });
            innerDoc.querySelectorAll('button[iscustom="1"]').forEach(btn => dataMaps.buttons.set(btn.getAttribute('id'), { ID: btn.getAttribute('id'), Caption: btn.getAttribute('caption'), Layout: layoutName }));
            innerDoc.querySelectorAll('section').forEach(section => {
                const sectionName = section.querySelector('text > lang')?.getAttribute('text') || 'Unnamed Section';
                section.querySelectorAll('col').forEach(col => {
                    const origId = col.getAttribute('fieldid');
                    if (!origId || origId === 'blankcell') return;
                    const id = origId.startsWith('cust_') ? origId.replace('cust_', '') : origId;
                    if (!dataMaps.masterFieldMap.has(id)) { dataMaps.masterFieldMap.set(id, { fieldId: id, layoutLabel: col.querySelector('text > lang')?.getAttribute('text') || col.getAttribute('name'), section: sectionName, originalId: origId, layouts: {}, dependencies: [], dependencyContexts: [], visibilityOptions: null, dbInfo: null, lovs: { database: null, layout: null, dependency: null }, dependencyCondition: null }); }
                    const rec = dataMaps.masterFieldMap.get(id);
                    const req = col.getAttribute('req');
                    rec.layouts[type] = { isRequired: req === '1' || req === '2' ? 'Yes' : 'No', isReadOnly: col.getAttribute('readonly') === '1' ? 'Yes' : 'No', isHidden: col.getAttribute('hide') === '1' ? 'Yes' : 'No' };
                    const visNode = col.querySelector('visibility > visibilityoption');
                    if (visNode) rec.visibilityOptions = visNode.getAttribute('displaynames')?.split(',') || [];
                    const depNode = col.querySelector('dependents');
                    if (depNode) {
                        if (!rec.dependencyContexts.includes(type)) rec.dependencyContexts.push(type);
                        depNode.querySelectorAll('option').forEach(opt => {
                            const onValue = opt.getAttribute('name');
                            const childFields = Array.from(opt.querySelectorAll('dependent')).map(dep => dep.getAttribute('id'));
                            const existingDep = rec.dependencies.find(d => d.onValue === onValue);
                            if (existingDep) {
                                existingDep.childFields.push(...childFields);
                                existingDep.childFields = [...new Set(existingDep.childFields)]; // remove duplicates
                            } else {
                                rec.dependencies.push({ onValue, childFields });
                            }
                        });
                    }
                });
            });
        });
    });
}

/**
 * Parses the database field schema XML.
 * @param {Document} doc - The XML document node containing field schema data.
 * @returns {Map} A map of field data, keyed by Field ID.
 */
function _parseDbXml(doc) {
    const data = new Map();
    doc.querySelectorAll('Field').forEach(fieldNode => {
        const id = fieldNode.querySelector('FIELDID')?.textContent;
        if (!id) return;
        data.set(id, {
            FieldID: id,
            Label: fieldNode.querySelector('LABEL')?.textContent,
            FieldType: fieldNode.querySelector('FieldType')?.textContent,
            Length: fieldNode.querySelector('LENGTH')?.textContent,
            DefaultValue: fieldNode.querySelector('DEFAULTVALUE')?.textContent,
            TableName: fieldNode.querySelector('TABLENAME')?.textContent,
            FieldName: fieldNode.querySelector('FIELDNAME')?.textContent,
            ColumnName: `${fieldNode.querySelector('TABLENAME')?.textContent}.${fieldNode.querySelector('FIELDNAME')?.textContent}`,
            LOVS: fieldNode.querySelector('LOVS')?.textContent.trim() ? fieldNode.querySelector('LOVS').textContent.trim().split(/, ?/) : null
        });
    });
    return data;
}
