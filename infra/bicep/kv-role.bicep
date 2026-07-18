// Grants a principal a role on an existing Key Vault. Split into a module
// because the vault may live in a different resource group than the app, and a
// roleAssignment scope must be evaluated in the vault's own resource group.
targetScope = 'resourceGroup'

@description('Name of the existing Key Vault to grant on.')
param keyVaultName string

@description('Principal (managed identity) to grant.')
param principalId string

@description('Role definition GUID. Default is Key Vault Secrets User.')
param roleDefinitionId string = '4633458b-17de-408a-b874-0445c86b69e6'

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource assignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, principalId, roleDefinitionId)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
