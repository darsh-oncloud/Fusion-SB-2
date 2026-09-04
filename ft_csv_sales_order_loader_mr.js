/**
* @NApiVersion 2.1
* @NScriptType MapReduceScript
* @NModuleScope SameAccount
*/
define(['N/file', 'N/search', 'N/record', 'N/runtime', 'N/log'], function (file, search, record, runtime, log) {

    // Configuration / Script Parameter defaults
    const CONFIG = {
        FILE_ID_PARAM: 'custscript_sample_loader_order_file_id', // Direct File ID parameter

        PENDING_FOLDER_ID: 2488938,                          // Pending Files
        PROCESSED_FOLDER_ID: 2488939,                        // Processed Files
        ERROR_FOLDER_ID: 2488940,                            // Error Files

        CUSTOMER_ID: 972653,                                 // Hardcoded Customer ID
        LOCATION_ID: 32,                                     // Hardcoded Location ID (CA2)
        MG_SOURCE_SYSTEM_ID: 2,                               // custentity_ft_sourcesystem value ID for MG
        CUST_REF_RECORD_TYPE: 'customrecord_ft_cust_references',
        CUST_REF_QUALIFIER_SID: 1,                            // custrecord_ft_cr_qualifier internal id for "SID"
        CUST_REF_QUALIFIER_PO: 2                              // custrecord_ft_cr_qualifier internal id for "PO Number"
    };

    // Helper: Return every file sitting inside a given cabinet folder
    function getFilesFromFolder(folderId) {
        const out = [];
        try {
            const fileSearch = search.create({
                type: 'file',
                filters: [['folder', 'anyof', String(folderId)]],
                columns: ['name', 'internalid']
            });

            fileSearch.run().each(function (res) {
                out.push({
                    id: res.id,
                    name: res.getValue({ name: 'name' })
                });
                return true;
            });
        } catch (e) {
            log.error('Error searching folder files', {
                folderId: folderId,
                error: e
            });
        }
        return out;
    }

    // Helper: Move a file into another cabinet folder
    function moveFile(fileId, folderId) {
        try {
            const f = file.load({ id: fileId });
            f.folder = folderId;
            f.save();

            log.audit('File Moved', `File ${fileId} moved to folder ${folderId}`);
        } catch (e) {
            log.error('Error moving file', {
                fileId: fileId,
                folderId: folderId,
                error: e
            });
        }
    }

    // Helper: Parse CSV Line handling quotes and commas
    function parseCsvLine(line) {
        const out = [];
        let cur = '', inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (i + 1 < line.length && line[i + 1] === '"') { cur += '"'; i++; }
                    else inQuotes = false;
                } else cur += ch;
            } else {
                if (ch === ',') { out.push(cur); cur = ''; }
                else if (ch === '"') inQuotes = true;
                else cur += ch;
            }
        }
        out.push(cur);
        return out;
    }

    // Helper: Parse date from YYYY-MM-DD or MM/DD/YYYY formats
    function parseDateString(dateStr) {
        if (!dateStr) return null;

        let delimiter = '';
        if (dateStr.indexOf('/') !== -1) {
            delimiter = '/';
        } else if (dateStr.indexOf('-') !== -1) {
            delimiter = '-';
        }

        if (delimiter) {
            const parts = dateStr.split(delimiter);
            if (parts.length === 3) {
                let year, month, day;
                // If the first part is 4 digits, it's YYYY-MM-DD or YYYY/MM/DD
                if (parts[0].trim().length === 4) {
                    year = parseInt(parts[0], 10);
                    month = parseInt(parts[1], 10) - 1; // 0-based
                    day = parseInt(parts[2], 10);
                } else {
                    // Otherwise assume MM/DD/YYYY or MM-DD-YYYY
                    month = parseInt(parts[0], 10) - 1; // 0-based
                    day = parseInt(parts[1], 10);
                    year = parseInt(parts[2], 10);
                }
                // Fix 2-digit years (e.g. 26 -> 2026, 07 -> 2007)
                if (year < 100) {
                    year += 2000;
                }

                const resultDate = new Date(year, month, day, 12, 0, 0);
                log.debug('parseDateString debug', {
                    input: dateStr,
                    parts: parts,
                    parsed: { year: year, month: month, day: day },
                    result: resultDate ? resultDate.toString() : 'null'
                });
                return resultDate;
            }
        }
        return null;
    }

    // Helper: Map Terms to custom field ID (Prepaid = 2, Collect = 1, Third Party = 3)
    function getTermsId(termsText) {
        if (!termsText) return null;
        const term = termsText.trim().toUpperCase();
        if (term === 'PREPAID') return 2;
        if (term === 'COLLECT') return 1;
        if (term === 'THIRD PARTY' || term === 'THIRDPARTY') return 3;
        return null;
    }

    // Helper: Map Order Type to custbody_ft_inboundoutbound (O = 2, R/I = 1)
    function getInboundOutboundId(typeText) {
        if (!typeText) return null;
        const typeVal = typeText.trim().toUpperCase();
        if (typeVal === 'O') return 2;
        if (typeVal === 'R' || typeVal === 'I') return 1;
        return null;
    }

    // Helper: Get customer MG Order / Synapse Order checkbox flags without loading full record
    function getCustomerOrderFlags(customerId) {
        const flags = { mg: false, synapse: false };
        if (!customerId) return flags;
        try {
            const fields = search.lookupFields({
                type: 'customer',
                id: customerId,
                columns: ['custentity_ft_cus_mg_order', 'custentity_ft_cus_synapse_order']
            });
            if (fields) {
                flags.mg = (fields.custentity_ft_cus_mg_order === true || fields.custentity_ft_cus_mg_order === 'T');
                flags.synapse = (fields.custentity_ft_cus_synapse_order === true || fields.custentity_ft_cus_synapse_order === 'T');
            }
        } catch (e) {
            log.error('Error looking up customer order flags', { customerId: customerId, error: e });
        }
        return flags;
    }

    /**
     * Helper: Find the subcustomer under a parent customer that matches a given
     * Source System (custentity_ft_sourcesystem) and has Primary Transportation
     * Record (custentity_ft_cus_primary_transpo_record) checked.
     *
     * Used when the parent customer's MG Order checkbox is checked: the Sales
     * Order should be created against this subcustomer rather than the parent.
     *
     * @param {string|number} parentCustomerId
     * @param {number} sourceSystemId - custentity_ft_sourcesystem list value ID (e.g. 2 = MG)
     * @returns {number|null} internal ID of the matching subcustomer, or null
     */
    function findSubcustomerByType(parentCustomerId, sourceSystemId) {
        if (!parentCustomerId || !sourceSystemId) return null;
        try {
            const subSearch = search.create({
                type: search.Type.CUSTOMER,
                filters: [
                    ['parent', 'anyof', String(parentCustomerId)],
                    'AND',
                    ['custentity_ft_sourcesystem', 'anyof', String(sourceSystemId)],
                    'AND',
                    ['custentity_ft_cus_primary_transpo_record', 'is', 'T']
                ],
                columns: ['internalid']
            });

            const results = subSearch.run().getRange({ start: 0, end: 1 });
            if (results && results.length > 0) {
                return Number(results[0].id);
            }

            log.error('MG Subcustomer Not Found', `No subcustomer found under parent ${parentCustomerId} with source system ${sourceSystemId} and Primary Transportation Record checked.`);
        } catch (e) {
            log.error('Error searching MG subcustomer', {
                parentCustomerId: parentCustomerId,
                sourceSystemId: sourceSystemId,
                error: e
            });
        }
        return null;
    }

    // Helper: Search Item Master Alias first, then fallback to WH Master Item List
    function findWHMasterRecord(itemCode, customerId) {
        if (!itemCode || !customerId) return null;
        const cleanItemCode = String(itemCode).trim();

        /*
        * STEP 1:
        * First search from Item Master Alias
        */
        try {
            const aliasSearch = search.create({
                type: 'customrecord_ft_item_master_alias',
                filters: [
                    ['name', 'is', cleanItemCode],
                    'AND',
                    ['custrecord_ft_alias_item.custrecord_ft_item_mas_customer', 'anyof', String(customerId)]
                ],
                columns: [
                    search.createColumn({ name: 'name', label: 'Name' }),
                    search.createColumn({ name: 'custrecord_ft_alias_item', label: 'Item' })
                ]
            });

            const aliasResults = aliasSearch.run().getRange({
                start: 0,
                end: 1
            });

            if (aliasResults && aliasResults.length > 0) {
                const aliasName = aliasResults[0].getValue({
                    name: 'name'
                });

                const itemMasterId = aliasResults[0].getValue({
                    name: 'custrecord_ft_alias_item'
                });

                const itemMasterText = aliasResults[0].getText({
                    name: 'custrecord_ft_alias_item'
                });

                if (itemMasterId) {
                    log.audit('Item Found From Alias', {
                        itemCode: cleanItemCode,
                        customerId: customerId,
                        aliasName: aliasName,
                        itemMasterId: itemMasterId,
                        itemMasterText: itemMasterText
                    });

                    return {
                        id: itemMasterId,
                        name: itemMasterText || aliasName || cleanItemCode
                    };
                }

                log.error('Alias Found But Linked Item Missing', {
                    itemCode: cleanItemCode,
                    customerId: customerId,
                    aliasName: aliasName
                });
            }

        } catch (e) {
            log.error('Error searching Item Master Alias', {
                itemCode: cleanItemCode,
                customerId: customerId,
                error: e
            });
        }

        /*
        * STEP 2:
        * If Item Master Alias not found, use old WH Master Item List logic
        */

        try {
            const whSearch = search.create({
                type: 'customrecord_wh_master_item_list',
                filters: [
                    ['custrecord_ft_item_mas_customer.internalidnumber', 'equalto', String(customerId)],
                    'AND',
                    [["name", "is", cleanItemCode], "OR", ["custrecord_ft_item_mast_upc", "is", cleanItemCode], "OR", ["custrecord_ft_item_mast_gtin", "is", cleanItemCode], "OR", ["custrecord_ft_item_mast_retailer_item", "is", cleanItemCode], "OR", ["custrecord_ft_item_mast_consig_item_code", "is", cleanItemCode], "OR", ["custrecord_ft_item_mast_externalsys_id", "is", cleanItemCode]]
                ],
                columns: [
                    search.createColumn({ name: 'name' })
                ]
            });

            const whResults = whSearch.run().getRange({
                start: 0,
                end: 1
            });

            if (whResults && whResults.length > 0) {
                const whItemCode = whResults[0].getValue({
                    name: 'name'
                });

                log.audit('Item Found From WH Master Item List', {
                    itemCode: cleanItemCode,
                    customerId: customerId,
                    whMasterId: whResults[0].id,
                    whItemCode: whItemCode
                });

                return {
                    id: whResults[0].id,
                    name: whItemCode
                };
            }

            log.error('Item Not Found In Alias Or WH Master Item List', {
                itemCode: cleanItemCode,
                customerId: customerId
            });

        } catch (e) {
            log.error('Error searching WH Master Item List fallback', {
                itemId: cleanItemCode,
                customerId: customerId,
                error: e
            });
        }

        return null;
    }

    // Helper: Search NetSuite location by custrecord_ft_loc_short_key custom field
    function findLocationByKey(key) {
        if (!key) return null;
        try {
            const cleanKey = key.trim();
            const locSearch = search.create({
                type: search.Type.LOCATION,
                filters: [
                    ['custrecord_ft_loc_short_key', 'is', cleanKey]
                ],
                columns: ['internalid']
            });
            const results = locSearch.run().getRange({ start: 0, end: 1 });
            if (results && results.length > 0) {
                log.debug('findLocationByKey Match', { searchedKey: cleanKey, foundLocationId: results[0].id });
                return results[0].id;
            }
            log.debug('findLocationByKey No Match', { searchedKey: cleanKey, message: 'No location found with this custrecord_ft_loc_short_key value.' });
        } catch (e) {
            log.error(`Error searching location for key: ${key}`, e);
        }
        return null;
    }

    /**
     * Helper: Search a NetSuite custom list to find the internal ID of an option by name
     * @param {string} listId - The custom list ID (e.g. 'customlist_nmfc_codes')
     * @param {string} nameValue - The name text of the list option
     * @returns {number|null} The internal ID of the matching option, or null
     */
    function findCustomListIdByName(listId, nameValue) {
        if (!listId || !nameValue) return null;
        const targetText = String(nameValue).trim();
        if (!targetText) return null;
        try {
            const listSearch = search.create({
                type: listId,
                filters: [
                    ['name', 'is', targetText]
                ],
                columns: ['internalid']
            });
            const results = listSearch.run().getRange({ start: 0, end: 1 });
            if (results && results.length > 0) {
                return Number(results[0].id);
            }
        } catch (e) {
            log.error(`Error searching custom list ${listId} for name: ${targetText}`, e);
        }
        return null;
    }

    // Helper: Check if Sales Order already exists by externalid
    function salesOrderExists(externalId) {
        if (!externalId) return false;
        const soSearch = search.create({
            type: search.Type.SALES_ORDER,
            filters: [
                ['externalid', 'anyof', externalId],
                'AND',
                ['mainline', 'is', 'T']
            ],
            columns: ['internalid']
        });
        const results = soSearch.run().getRange({ start: 0, end: 1 });
        return (results && results.length > 0);
    }

    // Helper: Get customer default billing address or first address, along with email and fax
    function getCustomerBillingAddress(customerId) {
        if (!customerId) return null;
        const addressData = {
            attention: '',
            addresslabel: '',
            addressee: '',
            address1: '',
            address2: '',
            city: '',
            state: '',
            statedisplayname: '',
            zipcode: '',
            country: '',
            countrycode: '',
            addressphone: '',
            email: '',
            fax: ''
        };

        try {
            const customerFields = search.lookupFields({
                type: 'customer',
                id: customerId,
                columns: ['email', 'fax']
            });
            if (customerFields) {
                addressData.email = customerFields.email || '';
                addressData.fax = customerFields.fax || '';
            }
        } catch (e) {
            log.error('Error looking up customer email/fax', e);
        }

        try {
            const customerSearchObj = search.create({
                type: 'customer',
                filters: [
                    ['internalid', 'anyof', String(customerId)]
                ],
                columns: [
                    search.createColumn({
                        name: 'address',
                        join: 'Address',
                        label: 'Address'
                    }),
                    search.createColumn({
                        name: 'address1',
                        join: 'Address',
                        label: 'Address 1'
                    }),
                    search.createColumn({
                        name: 'address2',
                        join: 'Address',
                        label: 'Address 2'
                    }),
                    search.createColumn({
                        name: 'address3',
                        join: 'Address',
                        label: 'Address 3'
                    }),
                    search.createColumn({
                        name: 'addresslabel',
                        join: 'Address',
                        label: 'Address Label'
                    }),
                    search.createColumn({
                        name: 'addressphone',
                        join: 'Address',
                        label: 'Address Phone'
                    }),
                    search.createColumn({
                        name: 'addressee',
                        join: 'Address',
                        label: 'Addressee'
                    }),
                    search.createColumn({
                        name: 'attention',
                        join: 'Address',
                        label: 'Attention'
                    }),
                    search.createColumn({
                        name: 'city',
                        join: 'Address',
                        label: 'City'
                    }),
                    search.createColumn({
                        name: 'country',
                        join: 'Address',
                        label: 'Country'
                    }),
                    search.createColumn({
                        name: 'countrycode',
                        join: 'Address',
                        label: 'Country Code'
                    }),
                    search.createColumn({
                        name: 'isdefaultbilling',
                        join: 'Address',
                        label: 'Default Billing Address'
                    }),
                    search.createColumn({
                        name: 'isdefaultshipping',
                        join: 'Address',
                        label: 'Default Shipping Address'
                    }),
                    search.createColumn({
                        name: 'state',
                        join: 'Address',
                        label: 'State/Province'
                    }),
                    search.createColumn({
                        name: 'statedisplayname',
                        join: 'Address',
                        label: 'State/Province Display Name'
                    }),
                    search.createColumn({
                        name: 'zipcode',
                        join: 'Address',
                        label: 'Zip Code'
                    })
                ]
            });

            const results = customerSearchObj.run().getRange({ start: 0, end: 1000 });
            if (results && results.length > 0) {
                let billingRow = null;
                for (let i = 0; i < results.length; i++) {
                    const isDefaultBilling = results[i].getValue({
                        name: 'isdefaultbilling',
                        join: 'Address'
                    });
                    if (isDefaultBilling === true || isDefaultBilling === 'T') {
                        billingRow = results[i];
                        break;
                    }
                }

                if (!billingRow) {
                    billingRow = results[0];
                }

                addressData.attention = billingRow.getValue({ name: 'attention', join: 'Address' }) || '';
                addressData.addresslabel = billingRow.getValue({ name: 'addresslabel', join: 'Address' }) || '';
                addressData.addressee = billingRow.getValue({ name: 'addressee', join: 'Address' }) || '';
                addressData.address1 = billingRow.getValue({ name: 'address1', join: 'Address' }) || '';
                addressData.address2 = billingRow.getValue({ name: 'address2', join: 'Address' }) || '';
                addressData.city = billingRow.getValue({ name: 'city', join: 'Address' }) || '';
                addressData.state = billingRow.getValue({ name: 'state', join: 'Address' }) || '';
                addressData.statedisplayname = billingRow.getValue({ name: 'statedisplayname', join: 'Address' }) || '';
                addressData.zipcode = billingRow.getValue({ name: 'zipcode', join: 'Address' }) || '';
                addressData.country = billingRow.getValue({ name: 'country', join: 'Address' }) || '';
                addressData.countrycode = billingRow.getValue({ name: 'countrycode', join: 'Address' }) || '';
                addressData.addressphone = billingRow.getValue({ name: 'addressphone', join: 'Address' }) || '';
            }
        } catch (e) {
            log.error('Error fetching customer billing address search details', e);
        }

        return addressData;
    }

    // Helper: Add fixed placeholder items to a Sales Order's item sublist,
    // based on which order type(s) this specific order is for.
    function addOrderItems(soRec, orderLocationId, includeMG, includeSynapse) {
        if (includeMG) {
            soRec.selectNewLine({ sublistId: 'item' });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: 8797 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: 1 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: 0.01 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'amount', value: 0.01 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_source_system', value: 2 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'department', value: 10 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: orderLocationId });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: 'Placeholder item for initial order creation' });
            soRec.commitLine({ sublistId: 'item' });
        }

        if (includeSynapse) {
            soRec.selectNewLine({ sublistId: 'item' });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: 2990 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: 1 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: 0.01 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'amount', value: 0.01 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_source_system', value: 3 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'department', value: 4 });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location', value: orderLocationId });
            soRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'description', value: 'Place holder item for initial Synapse order creation' });
            soRec.commitLine({ sublistId: 'item' });
        }
    }

    /**
     * Helper: Create a single customrecord_ft_cust_references record linked to a Sales Order.
     * Used for both the "SID" reference (one per SO) and "PO Number" references (one per
     * unique PO found in the CSV rows for that SO) — only ever called for MG orders.
     *
     * @param {number} soId - internal id of the related Sales Order (custrecord_ft_cr_related_so)
     * @param {number} qualifierId - custrecord_ft_cr_qualifier internal id (1 = SID, 2 = PO Number)
     * @param {string} nameValue - value to store in the record's name field (the SID or PO number text)
     * @returns {number|null} internal id of the created reference record, or null on failure/skip
     */
    function createCustomerReferenceRecord(soId, qualifierId, nameValue) {
        if (!soId || !qualifierId || nameValue === undefined || nameValue === null || String(nameValue).trim() === '') {
            return null;
        }
        try {
            const refRec = record.create({
                type: CONFIG.CUST_REF_RECORD_TYPE,
                isDynamic: false
            });
            refRec.setValue({ fieldId: 'name', value: String(nameValue).trim() });
            refRec.setValue({ fieldId: 'custrecord_ft_cr_qualifier', value: qualifierId });
            refRec.setValue({ fieldId: 'custrecord_ft_cr_related_so', value: Number(soId) });

            const refId = refRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.audit('Created Customer Reference Record', {
                soId: soId,
                qualifierId: qualifierId,
                name: nameValue,
                refRecordId: refId
            });

            return refId;
        } catch (e) {
            log.error('Error Creating Customer Reference Record', {
                soId: soId,
                qualifierId: qualifierId,
                name: nameValue,
                error: e.message || e.toString()
            });
            return null;
        }
    }

    /**
     * Builds and saves a single Sales Order record for one "plan" (MG-only, Synapse-only,
     * or the default combined order). All order-level field logic that used to live inline
     * in reduce() lives here so it can be invoked once (default/single-checkbox case) or
     * twice (both-checkboxes case, one order per type).
     *
     * @param {Object} plan - { typeKey: 'MG'|'SYN'|null, externalId, includeMG, includeSynapse }
     * @param {Array} rows - all CSV rows for this SID
     * @param {Object} firstRow - the first row (order-level fields)
     * @param {string|number} customerId - parent customer (used for SID/lookups unrelated to entity)
     * @param {string|number} entityId - the customer/subcustomer to set as the SO's entity and
     *                                   whose billing address should be applied
     * @param {Object|null} soMapping - dynamic CSV->NS field mapping parameter
     * @returns {number|null} internal ID of the created Sales Order, or null on failure/skip
     */
    function buildAndSaveSalesOrder(plan, rows, firstRow, customerId, entityId, soMapping) {
        const sid = firstRow['SID - unique identifier for the ORDER/SN'] || firstRow['SID'];

        if (salesOrderExists(plan.externalId)) {
            log.audit('Sales Order Skip', `Sales Order with externalid "${plan.externalId}" already exists. Skipping creation.`);
            return null;
        }

        // Aggregate fields across all rows under this SID
        const poNumbers = [];
        let totalCases = 0;
        let totalWeight = 0;
        let totalPallets = 0;

        rows.forEach(row => {
            const po = (row['PO'] || '').trim();
            if (po && poNumbers.indexOf(po) === -1) {
                poNumbers.push(po);
            }
            totalCases += parseFloat(row['ORDER QTY IN CTN']) || 0;
            totalWeight += parseFloat(row['Line Weight']) || 0;
            totalPallets += parseFloat(row['Pallet Count']) || 0;
        });

        // Initialize Sales Order Record in Dynamic Mode
        const soRec = record.create({
            type: record.Type.SALES_ORDER,
            isDynamic: true
        });

        soRec.setValue('customform', 161);

        // Maps Type: O -> 2 (Outbound), R/I -> 1 (Inbound)
        const inboundOutbound = getInboundOutboundId(firstRow['TYPE']);
        if (inboundOutbound) {
            soRec.setValue({ fieldId: 'custbody_ft_inboundoutbound', value: inboundOutbound });
        }

        // Set Warehouse Appointment Date based on inbound/outbound type
        const shipDateVal = parseDateString(firstRow['SHIPDATE']);
        const deliverDateVal = parseDateString(firstRow['DUEDATE - MABD'] || firstRow['DUEDATE']) || shipDateVal;

        if (inboundOutbound === 1) { // Inbound
            if (deliverDateVal) {
                soRec.setValue({ fieldId: 'custbody_ft_wh_appt_date', value: deliverDateVal });
                log.debug('Set Warehouse Appt Date (Inbound)', deliverDateVal);
            }
        } else { // Outbound
            if (shipDateVal) {
                soRec.setValue({ fieldId: 'custbody_ft_wh_appt_date', value: shipDateVal });
                log.debug('Set Warehouse Appt Date (Outbound)', shipDateVal);
            }
        }

        // Determine Location based on Outbound vs Inbound
        const typeVal = (firstRow['TYPE'] || '').trim().toUpperCase();
        let locationKey = '';
        if (typeVal === 'O') {
            locationKey = firstRow['SHIP FROM SHORT KEY'];
        } else if (typeVal === 'R' || typeVal === 'I') {
            locationKey = firstRow['SHIP TO SHORT KEY'];
        }

        log.debug('Location Resolution Inputs', {
            sid: sid,
            rawType: firstRow['TYPE'],
            typeVal: typeVal,
            shipFromShortKey: firstRow['SHIP FROM SHORT KEY'],
            shipToShortKey: firstRow['SHIP TO SHORT KEY'],
            locationKeyChosen: locationKey
        });

        let orderLocationId = CONFIG.LOCATION_ID;
        if (locationKey) {
            const foundLocId = findLocationByKey(locationKey);
            if (foundLocId) {
                orderLocationId = foundLocId;
                log.audit('Location Mapped', `Mapped location key "${locationKey}" to NetSuite Location ID: ${orderLocationId}`);
            } else {
                log.audit('Location Fallback', `Location key "${locationKey}" not found in NetSuite. Using default: ${orderLocationId}`);
            }
        } else {
            log.debug('No Location Key', `No location key found for type: "${typeVal}". Using default: ${orderLocationId}`);
        }

        // Set main body fields
        soRec.setValue({ fieldId: 'entity', value: entityId });
        soRec.setValue({ fieldId: 'location', value: orderLocationId });
        soRec.setValue({ fieldId: 'externalid', value: plan.externalId });
        soRec.setValue({ fieldId: 'custbody_po_number_vb', value: poNumbers.join(', ') });

        // Custom aggregated body fields
        soRec.setValue({ fieldId: 'custbody_ft_totalcases', value: totalCases });
        soRec.setValue({ fieldId: 'custbody_ft_totalweight', value: totalWeight });
        soRec.setValue({ fieldId: 'custbody_ft_totalpallets', value: totalPallets });

        // Custom body mappings (SID is core identifier)
        soRec.setValue({ fieldId: 'custbody_ft_sid', value: sid });

        // Fetch and set billing address fields for the entity being set on this SO
        const billingAddress = getCustomerBillingAddress(entityId);
        log.audit('Billing Address Lookup Result', {
            externalId: plan.externalId,
            entityIdUsedForLookup: entityId,
            billingAddress: billingAddress
        });
        if (billingAddress) {
            if (billingAddress.attention) soRec.setValue({ fieldId: 'custbody_ft_billattention', value: billingAddress.attention });
            if (billingAddress.addresslabel) soRec.setValue({ fieldId: 'custbody_ft_billloccode', value: billingAddress.addresslabel });
            if (billingAddress.addressee) soRec.setValue({ fieldId: 'custbody_ft_billaddressee', value: billingAddress.addressee });
            if (billingAddress.address1) soRec.setValue({ fieldId: 'custbody_ft_billaddress1', value: billingAddress.address1 });
            if (billingAddress.address2) soRec.setValue({ fieldId: 'custbody_ft_billaddress2', value: billingAddress.address2 });
            if (billingAddress.city) soRec.setValue({ fieldId: 'custbody_ft_billcity', value: billingAddress.city });
            if (billingAddress.state) soRec.setValue({ fieldId: 'custbody_ft_billstate', value: billingAddress.state });
            if (billingAddress.zipcode) soRec.setValue({ fieldId: 'custbody_ft_billzip', value: billingAddress.zipcode });
            if (billingAddress.countrycode) {
                soRec.setValue({ fieldId: 'custbody_ft_billcountry', value: billingAddress.countrycode });
            } else if (billingAddress.country) {
                soRec.setValue({ fieldId: 'custbody_ft_billcountry', value: billingAddress.country });
            }
            if (billingAddress.addressphone) soRec.setValue({ fieldId: 'custbody_ft_billphone', value: billingAddress.addressphone });
            if (billingAddress.email) soRec.setValue({ fieldId: 'custbody_ft_billemail', value: billingAddress.email });
            if (billingAddress.fax) soRec.setValue({ fieldId: 'custbody_ft_billfax', value: billingAddress.fax });
        }

        // Apply field mappings (Dynamic via parameter OR Legacy Hardcoded Fallback)
        if (soMapping) {
            for (const csvHeader in soMapping) {
                const nsFieldId = soMapping[csvHeader];
                const csvValue = firstRow[csvHeader];
                if (csvValue !== undefined && csvValue !== null && csvValue !== '') {
                    if (nsFieldId.indexOf('.') !== -1) {
                        const parts = nsFieldId.split('.');
                        const subrecId = parts[0];
                        const subfieldId = parts[1];
                        try {
                            const subrec = soRec.getSubrecord({ fieldId: subrecId });
                            if (subrec) {
                                let subValue = csvValue;
                                if (subfieldId === 'country') {
                                    const country = String(csvValue).trim().toUpperCase();
                                    if (country === 'USA') {
                                        subValue = 'US';
                                    } else {
                                        subValue = country;
                                    }
                                }
                                subrec.setValue({ fieldId: subfieldId, value: subValue });
                            }
                        } catch (subErr) {
                            log.error(`Error setting subrecord ${subrecId} field ${subfieldId}`, subErr);
                        }
                    } else {
                        if (nsFieldId === 'custbody_ft_planshipdate' || nsFieldId === 'custbody_ft_plandelivery' || nsFieldId === 'trandate' || nsFieldId === 'shipdate') {
                            const dateObj = parseDateString(csvValue);
                            if (dateObj) {
                                soRec.setValue({ fieldId: nsFieldId, value: dateObj });
                            }
                        } else if (nsFieldId === 'custbody_ft_inboundoutbound') {
                            const io = getInboundOutboundId(csvValue);
                            if (io) {
                                soRec.setValue({ fieldId: nsFieldId, value: io });
                            }
                        } else if (nsFieldId === 'custbody_ft_shipmethod') {
                            const termsId = getTermsId(csvValue);
                            if (termsId) {
                                soRec.setValue({ fieldId: nsFieldId, value: termsId });
                            }
                        } else if (nsFieldId === 'entity') {
                            // Never let the dynamic CSV mapping override the entity we
                            // already resolved (parent customer vs. MG subcustomer above).
                            log.audit('Header Entity Mapping Skipped', {
                                csvHeader: csvHeader,
                                csvValue: csvValue,
                                message: 'Ignoring mapped "entity" field from soMapping; entity is controlled by MG subcustomer resolution logic.'
                            });
                        } else if (nsFieldId === 'location') {
                            const foundLocId = findLocationByText(csvValue);

                            if (foundLocId) {
                                soRec.setValue({
                                    fieldId: 'location',
                                    value: Number(foundLocId)
                                });

                                log.audit('Header Location Set From CSV', {
                                    csvValue: csvValue,
                                    locationInternalId: foundLocId
                                });
                            } else {
                                log.error('Header Location Not Found', {
                                    csvValue: csvValue,
                                    message: 'No active NetSuite Location found by CSV text/name or internal ID.'
                                });
                            }
                        } else {
                            const valStr = String(csvValue).trim().toLowerCase();
                            try {
                                if (valStr === 't' || valStr === 'true') {
                                    soRec.setValue({ fieldId: nsFieldId, value: true });
                                } else if (valStr === 'f' || valStr === 'false') {
                                    soRec.setValue({ fieldId: nsFieldId, value: false });
                                } else {
                                    soRec.setValue({ fieldId: nsFieldId, value: csvValue });
                                }
                                log.debug('Header Mapped Field Set', {
                                    csvHeader: csvHeader,
                                    nsFieldId: nsFieldId,
                                    csvValue: csvValue
                                });
                            } catch (setErr) {
                                log.error('Header Mapped Field Set FAILED', {
                                    csvHeader: csvHeader,
                                    nsFieldId: nsFieldId,
                                    csvValue: csvValue,
                                    error: setErr.message || setErr.toString()
                                });
                            }
                        }
                    }
                } else {
                    log.debug('Header Mapping Skipped (blank/undefined)', {
                        csvHeader: csvHeader,
                        nsFieldId: nsFieldId,
                        rawValue: csvValue
                    });
                }
            }
        } else {
            // Dates
            const shipDate = parseDateString(firstRow['SHIPDATE']);
            if (shipDate) {
                soRec.setValue({ fieldId: 'custbody_ft_planshipdate', value: shipDate });
            }

            const dueDate = parseDateString(firstRow['DUEDATE - MABD'] || firstRow['DUEDATE']);
            if (dueDate) {
                soRec.setValue({ fieldId: 'custbody_ft_plandelivery', value: dueDate });
            }

            // Terms mapping to custom field
            const termsId = getTermsId(firstRow['TERMS']);
            if (termsId) {
                soRec.setValue({ fieldId: 'custbody_ft_shipmethod', value: termsId });
            }

            // Custom body mappings (Shipping Loc Code, and Ship From Address)
            if (firstRow['SHIP FROM SHORT KEY']) {
                soRec.setValue({ fieldId: 'custbody_ft_shiploccode', value: firstRow['SHIP FROM SHORT KEY'] });
            }
            if (firstRow['SHIP FROM ADDRESS1']) {
                soRec.setValue({ fieldId: 'custbody_ft_shipfromadd1', value: firstRow['SHIP FROM ADDRESS1'] });
            }
            if (firstRow['SHIP FROM CITY']) {
                soRec.setValue({ fieldId: 'custbody_ft_shipfromcity', value: firstRow['SHIP FROM CITY'] });
            }
            if (firstRow['SHIP FROM STATE']) {
                soRec.setValue({ fieldId: 'custbody_ft_shipfromstate', value: firstRow['SHIP FROM STATE'] });
            }
            if (firstRow['SHIP FROM ZIP CODE'] || firstRow['SHIP FROM ZIP']) {
                soRec.setValue({ fieldId: 'custbody_ft_shipfromzip', value: firstRow['SHIP FROM ZIP CODE'] || firstRow['SHIP FROM ZIP'] });
            }
            if (firstRow['SHIP FROM CTRY']) {
                soRec.setValue({ fieldId: 'custbody_ft_shipfromcountry', value: firstRow['SHIP FROM CTRY'] });
            }

        }

        // Legacy Shipping Address Subrecord (Always update standard Shipping Address if ship-to fields are present)
        const shipAddr = soRec.getSubrecord({ fieldId: 'shippingaddress' });
        if (shipAddr) {
            if (firstRow['SHIP TO NAME']) shipAddr.setValue({ fieldId: 'addressee', value: firstRow['SHIP TO NAME'] });
            if (firstRow['SHIP TO ADDRESS 1']) shipAddr.setValue({ fieldId: 'addr1', value: firstRow['SHIP TO ADDRESS 1'] });
            if (firstRow['SHIP TO CITY']) shipAddr.setValue({ fieldId: 'city', value: firstRow['SHIP TO CITY'] });
            if (firstRow['SHIP TO STATE']) shipAddr.setValue({ fieldId: 'state', value: firstRow['SHIP TO STATE'] });
            if (firstRow['SHIP TO ZIP CODE']) shipAddr.setValue({ fieldId: 'zip', value: firstRow['SHIP TO ZIP CODE'] });

            const country = (firstRow['SHIP TO CTRY'] || '').trim().toUpperCase();
            if (country === 'USA') {
                shipAddr.setValue({ fieldId: 'country', value: 'US' });
            } else if (country) {
                shipAddr.setValue({ fieldId: 'country', value: country });
            }
        }

        // Add Sublist Items according to this plan (MG -> item 8797, Synapse -> item 2990)
        addOrderItems(soRec, orderLocationId, plan.includeMG, plan.includeSynapse);

        // Re-apply header location right before saving to prevent Dynamic Mode sourcing from clearing it.
        // NOTE: entity is deliberately NOT re-set here — changing 'entity' in dynamic mode after
        // line items have been added triggers re-sourcing that wipes the item sublist, causing
        // "You must enter at least one line item for this transaction." Entity is set once, early,
        // and protected from the CSV mapping loop above; it must not be touched again after
        // addOrderItems() runs.
        soRec.setValue({ fieldId: 'location', value: orderLocationId });

        // Verify what is actually set on the record right before save (not just the
        // intended variable), so any future field-mapping collisions are visible in logs.
        const entityOnRecordBeforeSave = soRec.getValue({ fieldId: 'entity' });
        if (String(entityOnRecordBeforeSave) !== String(entityId)) {
            log.error('Entity Mismatch Before Save', `SID/externalid ${plan.externalId}: expected entity ${entityId} but record has ${entityOnRecordBeforeSave} right before save.`);
        }

        // Full pre-save snapshot of the fields we care about diagnosing, read directly
        // off the record object (not the JS variables), so we can see the TRUE end state
        // right before save() runs — including anything sourcing may have touched.
        function safeGet(fieldId) {
            try {
                return soRec.getValue({ fieldId: fieldId });
            } catch (e) {
                return `<error reading ${fieldId}: ${e.message || e}>`;
            }
        }
        log.audit('Pre-Save Field Snapshot', {
            externalId: plan.externalId,
            entity: safeGet('entity'),
            location: safeGet('location'),
            custbody_ft_shiploccode: safeGet('custbody_ft_shiploccode'),
            custbody_ft_shipfromadd1: safeGet('custbody_ft_shipfromadd1'),
            custbody_ft_shipfromcity: safeGet('custbody_ft_shipfromcity'),
            custbody_ft_shipfromstate: safeGet('custbody_ft_shipfromstate'),
            custbody_ft_shipfromzip: safeGet('custbody_ft_shipfromzip'),
            custbody_ft_shipfromcountry: safeGet('custbody_ft_shipfromcountry'),
            custbody_ft_consignatt: safeGet('custbody_ft_consignatt'),
            custbody_ft_consignaddressee: safeGet('custbody_ft_consignaddressee'),
            custbody_ft_consignadd1: safeGet('custbody_ft_consignadd1'),
            custbody_ft_consignadd2: safeGet('custbody_ft_consignadd2'),
            custbody_ft_consigncity: safeGet('custbody_ft_consigncity'),
            custbody_ft_consignstate: safeGet('custbody_ft_consignstate'),
            custbody_ft_consignzip: safeGet('custbody_ft_consignzip'),
            custbody_ft_consigncountry: safeGet('custbody_ft_consigncountry'),
            custbody_ft_billattention: safeGet('custbody_ft_billattention'),
            custbody_ft_billaddress1: safeGet('custbody_ft_billaddress1'),
            custbody_ft_billcity: safeGet('custbody_ft_billcity'),
            custbody_ft_billstate: safeGet('custbody_ft_billstate'),
            custbody_ft_billzip: safeGet('custbody_ft_billzip'),
            custbody_ft_billcountry: safeGet('custbody_ft_billcountry')
        });

        try {
            const soId = soRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.audit('Sales Order Created Successfully', `Created Sales Order ID: ${soId} for externalid: ${plan.externalId} (orderType: ${plan.typeKey || 'DEFAULT'}, entity: ${entityOnRecordBeforeSave})`);

            // Post-save read-back: load the saved record fresh and re-check the same fields.
            // If these differ from the Pre-Save snapshot above, something during save()
            // (most likely enableSourcing re-deriving fields from the entity) changed them.
            try {
                const savedRec = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });
                log.audit('Post-Save Field Snapshot', {
                    soId: soId,
                    externalId: plan.externalId,
                    entity: savedRec.getValue({ fieldId: 'entity' }),
                    location: savedRec.getValue({ fieldId: 'location' }),
                    custbody_ft_shipfromadd1: savedRec.getValue({ fieldId: 'custbody_ft_shipfromadd1' }),
                    custbody_ft_consignadd1: savedRec.getValue({ fieldId: 'custbody_ft_consignadd1' }),
                    custbody_ft_billaddress1: savedRec.getValue({ fieldId: 'custbody_ft_billaddress1' })
                });
            } catch (reloadErr) {
                log.error('Post-Save Reload Failed', { soId: soId, error: reloadErr.message || reloadErr.toString() });
            }

            // For MG orders only: create customrecord_ft_cust_references records linked to
            // this Sales Order — one for the SID itself (qualifier = SID), and one per unique
            // PO number found across the CSV rows for this SID (qualifier = PO Number).
            if (plan.typeKey === 'MG') {
                createCustomerReferenceRecord(soId, CONFIG.CUST_REF_QUALIFIER_SID, sid);

                poNumbers.forEach(function (po) {
                    createCustomerReferenceRecord(soId, CONFIG.CUST_REF_QUALIFIER_PO, po);
                });
            }

            return soId;
        } catch (saveErr) {
            log.error(`Error saving Sales Order for externalid ${plan.externalId}`, saveErr);
            return null;
        }
    }

    // ================== ENTRY POINTS ==================

    /**
    * Gets all files from the Pending folder, plus the optional parameter file
    */
    function getInputData() {
        try {
            const script = runtime.getCurrentScript();

            const paramFileId = script.getParameter({
                name: CONFIG.FILE_ID_PARAM
            });

            // Get all files from Pending folder
            const files = getFilesFromFolder(CONFIG.PENDING_FOLDER_ID);

            // Also process parameter file if provided
            if (paramFileId) {
                const already = files.some(function (f) {
                    return String(f.id) === String(paramFileId);
                });

                if (!already) {
                    files.push({
                        id: paramFileId,
                        name: 'Param_File_' + paramFileId + '.csv'
                    });
                }
            }

            log.audit('getInputData', `Files to process: ${files.length}`);

            return files;
        } catch (e) {
            log.error('Error in getInputData', e.message || e.toString());
            return [];
        }
    }

    /**
    * Map stage: Loads each file, parses rows, and writes grouped by SID
    */
    function map(context) {
        let fileId;
        let fileName;
        try {
            const fileMeta = JSON.parse(context.value);
            fileId = fileMeta.id;
            fileName = fileMeta.name;

            log.audit('map stage', `Processing file: ${fileName} (ID: ${fileId})`);

            const f = file.load({ id: fileId });
            const iterator = f.lines.iterator();

            let header = null;
            let lineIndex = 0;
            let emittedCount = 0;

            iterator.each(function (lineObj) {
                lineIndex++;
                let lineText = lineObj.value;

                // Strip BOM if present on the first line
                if (lineIndex === 1 && lineText && lineText.charCodeAt(0) === 0xFEFF) {
                    lineText = lineText.substring(1);
                }

                if (!lineText || lineText.trim() === '') {
                    return true;
                }

                // Parse the line columns
                const columns = parseCsvLine(lineText);

                // Row 1: Header Definitions
                if (lineIndex === 1) {
                    header = columns.map(c => c.trim());
                    log.audit('CSV Header Parsed', {
                        fileId: fileId,
                        fileName: fileName,
                        headerCount: header.length,
                        header: header
                    });
                    return true;
                }

                // Build Row Object
                const row = {};
                for (let c = 0; c < header.length; c++) {
                    row[header[c]] = (c < columns.length ? columns[c].trim() : '');
                }

                log.debug('CSV Row Parsed', {
                    lineIndex: lineIndex,
                    columnCount: columns.length,
                    row: row
                });

                // SID is the unique identifier for order grouping
                const sid = row['SID - unique identifier for the ORDER/SN'] || row['SID'];
                if (!sid || sid.trim() === '') {
                    log.debug('Skip Row', `Line ${lineIndex} skipped (empty/missing SID)`);
                    return true;
                }

                context.write({
                    key: sid.trim(),
                    value: JSON.stringify(row)
                });
                emittedCount++;
                return true;
            });

            log.audit('File processing complete', `Processed ${lineIndex} lines in ${fileName}. Emitted ${emittedCount} rows.`);

            // SUCCESS -> Processed Files
            moveFile(fileId, CONFIG.PROCESSED_FOLDER_ID);

        } catch (e) {
            log.error(`Error in map stage for file ID ${fileId}`, e.message || e.toString());

            // ERROR -> Error Files
            if (fileId) {
                moveFile(fileId, CONFIG.ERROR_FOLDER_ID);
            }
        }
    }

    /**
    * Reduce stage: Groups rows by SID and creates one or two Sales Orders,
    * depending on the customer's MG Order / Synapse Order checkboxes.
    */
    function reduce(context) {
        const sid = context.key;
        const rows = context.values.map(v => JSON.parse(v));

        log.audit('reduce stage', `Creating Sales Order(s) for SID: ${sid} (Rows to process: ${rows.length})`);

        const script = runtime.getCurrentScript();
        const soMappingStr = script.getParameter({ name: 'custscript_sales_order_mapping' });
        const itemMappingStr = script.getParameter({ name: 'custscript_inventory_item_mapping' });
        const dropdownMappingStr = script.getParameter({ name: 'custscript_dropdown_list_mappings' });

        let soMapping = null;
        if (soMappingStr) {
            try {
                soMapping = JSON.parse(soMappingStr);
            } catch (e) {
                log.error('Error parsing sales order mapping JSON', e);
            }
        }

        let itemMapping = null;
        if (itemMappingStr) {
            try {
                itemMapping = JSON.parse(itemMappingStr);
            } catch (e) {
                log.error('Error parsing inventory item mapping JSON', e);
            }
        }

        let dropdownMappings = {
            'custrecord_ft_invitem_freightclass': 'customlist_nmfc_codes',
            'custrecord_ft_invitem_contract_type': 'customlist_inventory_item_contract_typ',
            'custrecord_ft_invitem_uom': 'customlist1488'
        };
        if (dropdownMappingStr) {
            try {
                const parsedDropdowns = JSON.parse(dropdownMappingStr);
                for (const key in parsedDropdowns) {
                    dropdownMappings[key] = parsedDropdowns[key];
                }
            } catch (e) {
                log.error('Error parsing dropdown list mappings JSON', e);
            }
        }

        try {
            // Find the row with the most populated fields to use as the header source (firstRow).
            // This prevents issues where an incomplete row (e.g. trailing row or multi-line item row
            // with empty header values) is arbitrarily sorted first in context.values.
            let firstRow = rows[0];
            let maxPopulatedCount = -1;
            rows.forEach(row => {
                let populatedCount = 0;
                for (const key in row) {
                    if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
                        populatedCount++;
                    }
                }
                if (populatedCount > maxPopulatedCount) {
                    maxPopulatedCount = populatedCount;
                    firstRow = row;
                }
            });
            const customerId = firstRow['Company ID'] || CONFIG.CUSTOMER_ID;

            log.audit('First Row Raw Data', { sid: sid, firstRow: firstRow });
            log.audit('First Row Keys', { sid: sid, keys: Object.keys(firstRow) });

            // Diagnostic: check every CSV header referenced by soMapping actually exists
            // as a key on this row. If a key is missing/undefined here, the corresponding
            // NS field will silently NOT be set later (guarded by `csvValue !== undefined`),
            // which looks exactly like "the mapping isn't working" but is really a header
            // name mismatch (extra space, different casing, hidden character, etc.).
            if (soMapping) {
                for (const csvHeader in soMapping) {
                    const rawVal = firstRow[csvHeader];
                    if (rawVal === undefined) {
                        log.error('Mapping Header Not Found On Row', {
                            sid: sid,
                            expectedCsvHeader: csvHeader,
                            mappedTo: soMapping[csvHeader],
                            message: 'This exact header was not found as a key on the parsed row. Check for whitespace/casing/hidden-character differences vs the actual CSV header.'
                        });
                    } else {
                        log.debug('Mapping Header Found On Row', {
                            sid: sid,
                            csvHeader: csvHeader,
                            mappedTo: soMapping[csvHeader],
                            value: rawVal
                        });
                    }
                }
            }

            // Look up the customer's MG Order / Synapse Order checkboxes (no record load)
            const orderFlags = getCustomerOrderFlags(customerId);
            log.audit('Customer Order Flags', { customerId: customerId, mg: orderFlags.mg, synapse: orderFlags.synapse });

            // Decide which Sales Order(s) to build based on the flags:
            // - Neither checked      -> 1 order, both items (8797 + 2990), externalid = SID           (original behavior)
            // - Only MG checked      -> 1 order, item 8797 only,          externalid = SID_MG
            // - Only Synapse checked -> 1 order, item 2990 only,          externalid = SID_SYN
            // - Both checked         -> 2 separate orders (SID_MG w/ 8797, SID_SYN w/ 2990)
            let orderPlans;
            if (orderFlags.mg && orderFlags.synapse) {
                orderPlans = [
                    { typeKey: 'MG', externalId: sid + '_MG', includeMG: true, includeSynapse: false },
                    { typeKey: 'SYN', externalId: sid + '_SYN', includeMG: false, includeSynapse: true }
                ];
            } else if (orderFlags.mg) {
                orderPlans = [
                    { typeKey: 'MG', externalId: sid + '_MG', includeMG: true, includeSynapse: false }
                ];
            } else if (orderFlags.synapse) {
                orderPlans = [
                    { typeKey: 'SYN', externalId: sid + '_SYN', includeMG: false, includeSynapse: true }
                ];
            } else {
                orderPlans = [
                    { typeKey: null, externalId: sid, includeMG: true, includeSynapse: true }
                ];
            }

            // When both checkboxes are checked we create 2 separate orders for the same SID.
            // Skip the custom inventory item creation loop in that case, since running it
            // twice for the same items would duplicate/error.
            const skipInventoryItemCreation = orderPlans.length > 1;

            const createdSoIds = [];

            // Track the specific Sales Order id(s) created for this SID, keyed by order
            // type, so the inventory item records built below can be linked to the correct
            // order via custrecord_ft_invitem_mgorder / custrecord_ft_invitem_synapse_order.
            let mgSoId = null;
            let synapseSoId = null;
            let defaultSoId = null; // used only when neither MG nor Synapse checkbox applies

            orderPlans.forEach(function (plan) {
                // Default: the Sales Order's entity is the parent customer from the file.
                let entityId = customerId;

                // If this is an MG plan (parent customer's MG Order checkbox is checked),
                // the SO must instead be created under the subcustomer that has
                // custentity_ft_sourcesystem = MG (2) and
                // custentity_ft_cus_primary_transpo_record checked.
                if (plan.typeKey === 'MG') {
                    const mgSubcustomerId = findSubcustomerByType(customerId, CONFIG.MG_SOURCE_SYSTEM_ID);
                    if (mgSubcustomerId) {
                        entityId = mgSubcustomerId;
                        log.audit('MG Subcustomer Resolved', `SID ${sid}: using subcustomer ${mgSubcustomerId} (parent ${customerId}) as Sales Order entity.`);
                    } else {
                        log.error('MG Subcustomer Fallback', `SID ${sid}: no matching MG subcustomer found under parent ${customerId}. Falling back to parent customer as entity.`);
                    }
                }

                const soId = buildAndSaveSalesOrder(plan, rows, firstRow, customerId, entityId, soMapping);
                if (soId) {
                    createdSoIds.push(soId);
                    if (plan.typeKey === 'MG') {
                        mgSoId = soId;
                    } else if (plan.typeKey === 'SYN') {
                        synapseSoId = soId;
                    } else {
                        defaultSoId = soId;
                    }
                }
            });

            // if (skipInventoryItemCreation) {
            //     log.audit('Inventory Item Creation Skipped', `Skipped custom inventory item creation for SID ${sid} because separate MG and Synapse orders were created.`);
            //     return;
            // }

            if (createdSoIds.length === 0) {
                // Either the order already existed (skip) or it failed to save; nothing to attach items to.
                return;
            }

            log.audit('Inventory Item Order Linkage', {
                sid: sid,
                mgSoId: mgSoId,
                synapseSoId: synapseSoId,
                defaultSoId: defaultSoId
            });

            // Group quantities/descriptions by WMS Item Number (same as original behavior)
            const itemQuantities = {};
            const itemDescriptions = {};
            const itemRows = {};

            rows.forEach(row => {
                const itemCode = (row['WMS_ITEM_NUMBER'] || '').trim();
                if (itemCode) {
                    itemQuantities[itemCode] = (itemQuantities[itemCode] || 0) + (parseFloat(row['ORDER QTY IN CTN']) || 0);
                    itemDescriptions[itemCode] = row['Item Desc'] || itemDescriptions[itemCode] || '';
                    if (!itemRows[itemCode]) {
                        itemRows[itemCode] = row;
                    }
                }
            });

            log.audit('Item Quantities Built', {
                sid: sid,
                itemCodesFound: Object.keys(itemQuantities),
                itemCodeCount: Object.keys(itemQuantities).length,
                message: 'If itemCodeCount is 0, no rows for this SID had a value in WMS_ITEM_NUMBER, so no inventory item records will be attempted at all.'
            });

            // Find WH Master record and create a new custom inventory item for each item code.
            // If no matching WH Master/Alias record is found, we still create the inventory item
            // record (rather than skipping it) using the raw CSV item code as the name, and we
            // simply leave custrecord_ft_invitem_item unset since there's no matched item to link.
            for (const itemCode in itemQuantities) {
                const whMasterRec = findWHMasterRecord(itemCode, customerId);
                if (!whMasterRec) {
                    log.error('Item Not Matched', `No WH Master Record found for Consignee Item: ${itemCode}. Creating Custom Inventory Item using the item code as name; custrecord_ft_invitem_item will be left blank.`);
                }

                try {
                    const invItemRec = record.create({
                        type: 'customrecord_ft_inventory_items',
                        isDynamic: true
                    });

                    invItemRec.setValue({ fieldId: 'name', value: whMasterRec ? whMasterRec.name : itemCode });
                    invItemRec.setValue({ fieldId: 'custrecord_ft_invitem_customer', value: customerId });
                    if (whMasterRec) {
                        invItemRec.setValue({ fieldId: 'custrecord_ft_invitem_item', value: whMasterRec.id });
                    }

                    // Link this inventory item record to the Sales Order(s) created for this SID:
                    // - MG only            -> custrecord_ft_invitem_mgorder = MG SO id
                    // - Synapse only       -> custrecord_ft_invitem_synapse_order = Synapse SO id
                    // - Both (MG + Synapse)-> create under the MG order (custrecord_ft_invitem_mgorder),
                    //                         then also populate custrecord_ft_invitem_synapse_order with
                    //                         the Synapse order id once that order has been created.
                    // - Neither checkbox   -> fall back to the original single combined order in
                    //                         custrecord_ft_invitem_mgorder (legacy behavior).
                    if (mgSoId) {
                        try {
                            invItemRec.setValue({ fieldId: 'custrecord_ft_invitem_mgorder', value: Number(mgSoId) });
                        } catch (mgLinkErr) {
                            log.error('Failed To Link MG Order On Inventory Item', {
                                sid: sid,
                                itemCode: itemCode,
                                mgSoId: mgSoId,
                                error: mgLinkErr.message || mgLinkErr.toString(),
                                message: 'custrecord_ft_invitem_mgorder rejected this Sales Order id. Check the field\'s source list/filters (e.g. subsidiary restriction) in Setup > Customization > Lists, Records & Fields.'
                            });
                        }
                    }
                    if (synapseSoId) {
                        try {
                            invItemRec.setValue({ fieldId: 'custrecord_ft_invitem_synapse_order', value: Number(synapseSoId) });
                        } catch (synLinkErr) {
                            log.error('Failed To Link Synapse Order On Inventory Item', {
                                sid: sid,
                                itemCode: itemCode,
                                synapseSoId: synapseSoId,
                                error: synLinkErr.message || synLinkErr.toString(),
                                message: 'custrecord_ft_invitem_synapse_order rejected this Sales Order id. Check the field\'s source list/filters (e.g. subsidiary restriction) in Setup > Customization > Lists, Records & Fields.'
                            });
                        }
                    }
                    if (!mgSoId && !synapseSoId && defaultSoId) {
                        try {
                            invItemRec.setValue({ fieldId: 'custrecord_ft_invitem_mgorder', value: Number(defaultSoId) });
                        } catch (defaultLinkErr) {
                            log.error('Failed To Link Default Order On Inventory Item', {
                                sid: sid,
                                itemCode: itemCode,
                                defaultSoId: defaultSoId,
                                error: defaultLinkErr.message || defaultLinkErr.toString(),
                                message: 'custrecord_ft_invitem_mgorder rejected this Sales Order id. Check the field\'s source list/filters (e.g. subsidiary restriction) in Setup > Customization > Lists, Records & Fields.'
                            });
                        }
                    }

                    // Apply dynamic inventory item mapping if present
                    if (itemMapping && itemRows) {
                        const representativeRow = itemRows[itemCode];
                        if (representativeRow) {
                            for (const csvHeader in itemMapping) {
                                const nsFieldId = itemMapping[csvHeader];
                                let csvValue = representativeRow[csvHeader];
                                if (csvHeader === 'ORDER QTY IN CTN') {
                                    csvValue = itemQuantities[itemCode];
                                }
                                if (csvValue !== undefined && csvValue !== null && csvValue !== '') {
                                    const lowFieldId = nsFieldId.toLowerCase();
                                    if (lowFieldId.indexOf('date') !== -1 || lowFieldId.indexOf('dt') !== -1) {
                                        const dateObj = parseDateString(csvValue);
                                        if (dateObj) {
                                            invItemRec.setValue({ fieldId: nsFieldId, value: dateObj });
                                        } else {
                                            invItemRec.setValue({ fieldId: nsFieldId, value: csvValue });
                                        }
                                    } else {
                                        const valStr = String(csvValue).trim().toLowerCase();
                                        if (valStr === 't' || valStr === 'true') {
                                            invItemRec.setValue({ fieldId: nsFieldId, value: true });
                                        } else if (valStr === 'f' || valStr === 'false') {
                                            invItemRec.setValue({ fieldId: nsFieldId, value: false });
                                        } else {
                                            let finalValue = csvValue;
                                            if (dropdownMappings[nsFieldId]) {
                                                const listId = dropdownMappings[nsFieldId];
                                                const resolvedId = findCustomListIdByName(listId, csvValue);
                                                if (resolvedId) {
                                                    finalValue = resolvedId;
                                                } else if (csvValue && !isNaN(Number(csvValue))) {
                                                    finalValue = Number(csvValue);
                                                } else {
                                                    log.error('Dropdown Resolution Failed', `Could not find option "${csvValue}" in custom list "${listId}" for field "${nsFieldId}". Setting to null to avoid crash.`);
                                                    finalValue = null;
                                                }
                                            } else if (lowFieldId.indexOf('qty') !== -1 || lowFieldId.indexOf('weight') !== -1 || lowFieldId.indexOf('cube') !== -1 || lowFieldId.indexOf('pallet') !== -1 || lowFieldId.indexOf('count') !== -1 || lowFieldId.indexOf('seq') !== -1 || lowFieldId.indexOf('amount') !== -1) {
                                                const parsedNum = Number(csvValue);
                                                if (!isNaN(parsedNum)) {
                                                    finalValue = parsedNum;
                                                }
                                            }
                                            invItemRec.setValue({ fieldId: nsFieldId, value: finalValue });
                                        }
                                    }
                                }
                            }
                        }
                    }

                    const invItemRecId = invItemRec.save({
                        enableSourcing: true,
                        ignoreMandatoryFields: true
                    });
                    log.audit('Created Custom Inventory Item', `Created customrecord_ft_inventory_items ID: ${invItemRecId} for item: ${whMasterRec ? whMasterRec.name : itemCode} (mgOrder: ${mgSoId || defaultSoId || 'none'}, synapseOrder: ${synapseSoId || 'none'})`);
                } catch (createErr) {
                    log.error(`Error creating customrecord_ft_inventory_items for item: ${whMasterRec ? whMasterRec.name : itemCode}`, createErr);
                }
            }

        } catch (err) {
            log.error(`Failed to process SID ${sid}`, err || err.toString());
        }
    }

    // Helper: Search NetSuite Location by header/list text and return internal ID
    function findLocationByText(locationText) {
        if (!locationText) return null;

        const searchText = String(locationText).trim();
        if (!searchText) return null;

        // If CSV already contains internal ID
        if (!isNaN(Number(searchText))) {
            return Number(searchText);
        }

        function normalize(value) {
            return String(value || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toUpperCase();
        }

        const targetText = normalize(searchText);
        let foundId = null;

        try {
            const locSearch = search.create({
                type: search.Type.LOCATION,
                filters: [
                    ['isinactive', 'is', 'F']
                ],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'name' })
                ]
            });

            locSearch.run().each(function (result) {
                const locId = result.getValue({ name: 'internalid' });
                const locName = result.getValue({ name: 'name' });

                const fullName = normalize(locName);
                const nameWithoutHierarchy = normalize(String(locName || '').split(':').pop());

                if (fullName === targetText || nameWithoutHierarchy === targetText) {
                    foundId = locId;
                    return false;
                }

                return true;
            });

        } catch (e) {
            log.error('Error searching location by text', {
                locationText: searchText,
                error: e
            });
        }

        return foundId;
    }

    /**
    * Map/Reduce execution summary log
    */
    function summarize(summary) {
        log.audit('Summarize stage', 'Map/Reduce completed.');
        if (summary.inputSummary.error) {
            log.error('Input Error', summary.inputSummary.error);
        }
        summary.mapSummary.errors.iterator().each((key, error) => {
            log.error(`Map Error for key ${key}`, error);
            return true;
        });
        summary.reduceSummary.errors.iterator().each((key, error) => {
            log.error(`Reduce Error for key ${key}`, error);
            return true;
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});