figma.showUI(__html__, { width: 300, height: 200 });

interface VariableAlias {
  type: "VARIABLE_ALIAS";
  id: string;
}

type VariableValueNew = string | number | boolean | VariableAlias | RGB;

interface VariableData {
  name: string;
  resolvedType?: VariableResolvedDataType;
  valuesByMode: Record<string, VariableValueNew>;
  scopes: VariableScope[];
  codeSyntax: {
    WEB?: string;
    ANDROID?: string;
    iOS?: string;
  };
  description?: string;
  remote: boolean;
  linkedVariables?: string[];
}

interface CollectionData {
  name: string;
  modes: { name: string; modeId: string }[];
  variables: Record<string, VariableData>;
}

async function exportVariables() {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const exportData: Record<string, CollectionData> = {};

  for (const collection of collections) {
    const variables = await figma.variables.getVariableCollectionByIdAsync(collection.id);
    const variableData: Record<string, VariableData> = {};

    const variableIds = variables?.variableIds; // Use optional chaining
    if (variableIds) { // Check if variableIds is not null or undefined
      for (const variableId of variableIds) {
        const variable = await figma.variables.getVariableByIdAsync(variableId);
        if (!variable) {
          continue; // Skip to the next iteration if variable is null
        }
        const linkedVars = Object.entries(variable.valuesByMode)
          .filter(([, value]) => 
            typeof value === 'object' && value !== null && 
            'type' in value && (value as VariableAlias).type === 'VARIABLE_ALIAS'
          )
          .map(([, value]) => {
            if (isVariableAlias(value)) {
              return value.id; // Safe to access 'id' here
            }
            return null; // Handle other cases if necessary
          })
          .filter((id): id is string => id !== null); // Filter out null values

        variableData[variable.id] = {
          name: variable.name,
          resolvedType: variable.resolvedType,
          valuesByMode: variable.valuesByMode,
          scopes: variable.scopes,
          codeSyntax: {
            WEB: variable.codeSyntax?.WEB,
            ANDROID: variable.codeSyntax?.ANDROID,
            iOS: variable.codeSyntax?.iOS
          },
          description: variable.description,
          remote: variable.remote,
          linkedVariables: linkedVars
        };
      }
    }

    exportData[collection.id] = {
      name: collection.name,
      modes: collection.modes,
      variables: variableData
    };
  }

  return exportData;
}

async function importVariables(data: Record<string, CollectionData>) {
  // Remove existing collections
  const existingCollections = await figma.variables.getLocalVariableCollectionsAsync();
  for (const collection of existingCollections) {
    await collection.remove();
  }

  // Create collections and their modes first
  const collectionMap = new Map<string, VariableCollection>();
  for (const [oldCollectionId, collectionData] of Object.entries(data)) {
    const collection = figma.variables.createVariableCollection(collectionData.name);
    collectionMap.set(oldCollectionId, collection);
    
    // Handle modes more carefully
    const defaultMode = collection.modes[0];
    const modeIdMap = new Map<string, string>();
    
    // Create all new modes first
    for (let i = 1; i < collectionData.modes.length; i++) {
      const mode = collectionData.modes[i];
      const newModeId = collection.addMode(mode.name);
      modeIdMap.set(mode.modeId, newModeId);
    }
    
    // Update the first mode instead of trying to remove it
    if (collectionData.modes.length > 0) {
      const firstMode = collectionData.modes[0];
      collection.renameMode(defaultMode.modeId, firstMode.name);
      modeIdMap.set(firstMode.modeId, defaultMode.modeId);
    }
  }

  // Create all variables first
  const variableMap = new Map<string, Variable>();
  for (const [collectionId, collectionData] of Object.entries(data)) {
    const collection = collectionMap.get(collectionId);
    if (!collection) continue;

    for (const [oldVarId, varData] of Object.entries(collectionData.variables)) {
      try {
        const variable = figma.variables.createVariable(
          varData.name,
          collection,
          varData.resolvedType || 'STRING' // Provide a default type if undefined
        );
        
        // Set description if available
        if (varData.description) {
          variable.description = varData.description;
        }
        
        // Set scopes
        if (varData.scopes) {
          variable.scopes = varData.scopes;
        }

        variableMap.set(oldVarId, variable);
      } catch (error) {
        console.error(`Failed to create variable ${varData.name}:`, error);
      }
    }
  }

  // Set values and links after all variables are created
  for (const [collectionId, collectionData] of Object.entries(data)) {
    const collection = collectionMap.get(collectionId);
    if (!collection) continue;

    for (const [oldVarId, varData] of Object.entries(collectionData.variables)) {
      const variable = variableMap.get(oldVarId);
      if (!variable) continue;

      // Set values for each mode
      for (const [oldModeId, value] of Object.entries(varData.valuesByMode)) {
        try {
          const modeId = collection.modes.find(m => m.name === collectionData.modes.find(cm => cm.modeId === oldModeId)?.name)?.modeId;
          
          if (!modeId) continue;

          if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'VARIABLE_ALIAS') {
            const referencedVar = variableMap.get(value.id);
            if (referencedVar) {
              variable.setValueForMode(modeId, {
                type: 'VARIABLE_ALIAS',
                id: referencedVar.id
              });
            }
          } else {
            variable.setValueForMode(modeId, value);
          }
        } catch (error) {
          console.error(`Failed to set value for variable ${varData.name} in mode ${oldModeId}:`, error);
        }
      }
    }
  }
}

// Type guard function
function isVariableAlias(value: VariableValue): value is VariableAlias {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'VARIABLE_ALIAS';
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'export') {
    const data = await exportVariables();
    figma.ui.postMessage({ type: 'exportData', data });
  } else if (msg.type === 'import') {
    try {
      await importVariables(msg.data);
      figma.notify('Variables imported successfully');
    } catch (error) {
      if (error instanceof Error) {
        figma.notify('Error importing variables: ' + error.message, { error: true });
      } else {
        figma.notify('Error importing variables: An unknown error occurred.', { error: true });
      }
    }
  }
};